import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ArtifactRow, Artifacts, Band, Observed, Summary, SummaryCache, Tab, Thread, Todo } from '../types'
import {
  demoArtifacts, demoObserved, demoSummary, emptyObserved, hash, isTestCommand, onAgent, onArtifact, onCommit, onEdit,
  isEngineText, onError, onPrompt, onTest, onTodos, onTurnEnd, parseSummary, short, snippet, stamp, testResult, SUMMARY_SYSTEM, summaryInput,
  summaryPrompt, SUMMARY_OUT,
} from './observe'

// Change a tag when that value's fields change: it declines what an older version stored.
const observed = atom({ plugin: 'whatcha-doing', key: 'observed' } as const, emptyObserved, { shape: 'observed-2' })
const tabAtom = atom({ plugin: 'whatcha-doing', key: 'tab' } as const, 'threads' as Tab, { shape: 'tab-3' })
const summary = atom({ plugin: 'whatcha-doing', key: 'summary' } as const, { key: '' } as SummaryCache, { shape: 'summary-1' })
const demo = atom({ plugin: 'whatcha-doing', key: 'isDemo' } as const, false, { shape: 'demo-1' })
const band = atom({ plugin: 'whatcha-doing', key: 'band' } as const, { mode: 'collapsed' } as Band, { shape: 'band-2' })
const artifacts = atom({ plugin: 'whatcha-doing', key: 'artifacts' } as const, { key: '', rows: [] } as Artifacts, { shape: 'artifacts-1' })
// The prompt box and its hint line under the band.
const PROMPT_ROWS = 4
/** Body rows: 30% of a tall terminal (40+ rows); a short one may give up to 90%, less the prompt. */
export const bodyCap = (rows: number) => Math.max(3, rows >= 40 ? Math.floor(rows * 0.3) : Math.floor(rows * 0.9) - PROMPT_ROWS)
const TABS: [Tab, string][] = [['threads', 'Threads'], ['summary', 'Summary'], ['artifacts', 'Artifacts']]

// A hook may not pass `$` on, so each hook spells these closures itself.
type SummaryIo = {
  state(): Promise<[isDemo: boolean, o: Observed, was: SummaryCache]>
  set(c: SummaryCache): Promise<unknown>
  complete(r: ModelCompleteRequest): Promise<ModelCompleteResult>
}

/** The one place a model is called: only when the Summary tab is shown, or on Refresh. */
async function showSummary(io: SummaryIo, force = false) {
  const [isDemo, o, was] = await io.state()
  if (isDemo) return
  const input = summaryInput(o)
  const key = hash(input)
  if (was.isLoading || (!force && was.key === key)) return
  if (o.threads.length === 0) return void (await io.set({ key, error: 'Nothing to sum up yet.' }))
  await io.set({ key, summary: was.summary, isLoading: true })
  const r = await io.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: summaryPrompt(input), maxTokens: SUMMARY_OUT, timeoutMs: 30000 })
  let next: SummaryCache
  if (!r.isAnswered) next = { key, error: `The estimate did not come back (${r.reason}). Press Refresh.` }
  else {
    try {
      next = { key, summary: parseSummary(r.text) }
    } catch {
      next = { key, error: 'The estimate came back in a form we could not read. Press Refresh.' }
    }
  }
  await io.set(next)
}

/** Everything a view draws, read once per draw. */
type Data = { o: Observed; cache: SummaryCache; arts: ArtifactRow[]; now: number; tab: Tab }
type Reads = {
  demo(): Promise<boolean>
  observed(): Promise<Observed>
  summary(): Promise<SummaryCache>
  artifacts(): Promise<Artifacts>
  tab(): Promise<Tab>
  now(): Promise<number>
}
async function load(r: Reads): Promise<Data> {
  const now = await r.now()
  const isDemo = await r.demo()
  return {
    now,
    o: isDemo ? demoObserved(now) : await r.observed(),
    cache: isDemo ? { key: 'demo', summary: demoSummary } : await r.summary(),
    arts: isDemo ? demoArtifacts(now) : (await r.artifacts()).rows,
    tab: await r.tab(),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whatcha',
      description: 'Open the Whatcha doing band (threads, summary, artifacts, all, close, min, demo, live)',
      argumentHint: '[open|threads|summary|artifacts|all|close|min|demo|live]',
    })
    if ((await $.env.get('WHATCHA_DEMO')) === '1') await update($, demo, () => true)
    // Artifacts outlive the session: one store key per project folder.
    const key = `artifacts:${e.cwd}`
    const rows = ((await $.store.get(key).catch(() => undefined)) as ArtifactRow[] | undefined) ?? []
    await update($, artifacts, () => ({ key, rows }))
    return next(e)
  })

  on('command.run', { command: 'whatcha' }, async ($, e) => {
    const io: SummaryIo = {
      state: async () => [await read($, demo), await read($, observed), await read($, summary)],
      set: c => update($, summary, () => c),
      complete: r => $.model.complete(r),
    }
    const [arg = 'open'] = e.args.trim().split(/\s+/).filter(Boolean)
    const tab = TABS.find(([id]) => id === arg)?.[0]
    if (arg === 'demo' || arg === 'live') await update($, demo, () => arg === 'demo')
    else if (arg === 'close' || arg === 'min') await update($, band, (b): Band => ({ ...b, mode: arg === 'min' ? 'min' : 'collapsed', all: false }))
    else if (arg === 'all') await update($, band, (x): Band => ({ ...x, mode: 'expanded', all: !x.all }))
    else {
      if (tab) await update($, tabAtom, () => tab)
      await update($, band, (x): Band => ({ ...x, mode: 'expanded', all: false }))
      if ((await read($, tabAtom)) === 'summary') await showSummary(io)
    }
    // The band itself shows the result: an output line per command only stacked noise above it.
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta && !isEngineText(e.text)) {
      const at = await $.clock.now()
      await update($, observed, o => stamp(onPrompt(o, e.text), at))
    }
    return next(e)
  })
    // Watching must never stop a prompt: on any failure, go on.
    .catch(($, e, next) => next(e))

  // The main loop's answer closes the current thread (done or answered); a subagent's does not.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await update($, observed, o => onTurnEnd(o, e.reason === 'answer')).catch(() => {})
    const r = await next(e)
    // An open Summary tab follows the work: re-ask Haiku once per turn, only when the threads changed (the key dedups).
    if (!e.agentId && (await read($, tabAtom)) === 'summary' && (await read($, band)).mode === 'expanded') {
      void showSummary({
        state: async () => [await read($, demo), await read($, observed), await read($, summary)],
        set: c => update($, summary, () => c),
        complete: q => $.model.complete(q),
      }).catch(() => {})
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const at = await $.clock.now()
      await update($, observed, o => stamp(observe(o, e, ran), at))
      const pub = published(e, ran)
      if (pub) {
        const a = await update($, artifacts, x => ({ ...x, rows: onArtifact(x.rows, pub.url, pub.title, at) }))
        if (a.key) await $.store.set(a.key, a.rows)
      }
    } catch {
      // Watching must never change a tool's result.
    }
    return ran
  })
    .catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Other mods share this slot: draw theirs below ours. next(e) rejects when nothing answers beneath (tests).
    const below = await next(e).catch(() => undefined)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const d = await load({
      demo: () => read($, demo), observed: () => read($, observed), summary: () => read($, summary),
      artifacts: () => read($, artifacts), tab: () => read($, tabAtom), now: () => $.clock.now(),
    })
    const b = await read($, band)
    const io: SummaryIo = {
      state: async () => [await read($, demo), await read($, observed), await read($, summary)],
      set: c => update($, summary, () => c),
      complete: r => $.model.complete(r),
    }
    const cols = e.props.bodyColumns
    const width = e.surface === 'terminal' ? cols : undefined
    const stack = (mine: NonNullable<typeof below>) => (below ? <Box flexDirection="column">{mine}{below}</Box> : mine)
    const setMode = (mode: Band['mode']) => update($, band, (x): Band => ({ ...x, mode, all: false }))
    const open = async (t: Tab) => {
      await update($, tabAtom, () => t)
      await update($, band, (x): Band => ({ ...x, mode: 'expanded', all: false }))
      if (t === 'summary') await showSummary(io)
    }
    const showAll = (all: boolean) => update($, band, (x): Band => ({ ...x, all }))
    const act: Acts = {
      all: () => showAll(true),
      less: b.all ? () => showAll(false) : undefined,
      copy: (url, surface) => $.ui.copy({ text: url, surface }).then(r => r.isCopied && $.ui.toast(`Copied ${url}`)),
    }

    if (b.mode === 'min') {
      return stack(
        <Box flexDirection="row" width={width}>
          <Box flexGrow={1} />
          <Button key="restore" plain label="▴ @whatcha-doing" onPress={() => setMode('collapsed')} />
        </Box>,
      )
    }

    const { o, cache, tab } = d
    const pct = cache.summary?.percent
    const now = byId(o, o.current)
    const over = o.threads.filter(isOver).length
    const isOpen = b.mode === 'expanded'
    // Under 120 columns the buttons do not fit beside the status: they take a row of their own.
    const isNarrow = cols < 120
    const status = (
      <Text wrap="truncate-end">
        <Text color="suggestion">●</Text> now: <Text bold>{now?.title ?? 'waiting for the first prompt'}</Text>
        <Text dimColor>  ·  {over}/{o.threads.length} threads done</Text>
        {pct !== undefined && <Text>  ·  ~{pct}% <Text color="suggestion">{meter(pct, 5)}</Text></Text>}
      </Text>
    )
    const buttons = (
      <Box flexDirection="row" gap={isNarrow ? 1 : 2}>
        {/* No hotkey labels: keys go to the prompt, the band takes clicks. */}
        {TABS.map(([id, label]) => (
          // Dim tabs read as disabled: every tab is full text, the open one bold in the accent color.
          <Button key={`tab-${id}`} label={label} plain onPress={() => open(id)}>
            {isOpen && tab === id ? <Text bold color="suggestion">{label}</Text> : label}
          </Button>
        ))}
        {isOpen && tab === 'summary' && <Button key="refresh" plain label="Refresh" onPress={() => showSummary(io, true)} />}
        {isOpen && b.all && <Button key="less" plain label="Show less" onPress={() => showAll(false)} />}
        {isOpen && <Button key="compact" plain label="Compact" onPress={() => setMode('collapsed')} />}
        {/* Not "[-]": the engine draws its own [-] right after, which hides the band fully. */}
        <Button key="min" plain label="▾" onPress={() => setMode('min')} />
      </Box>
    )
    const row = isNarrow ? (
      <Box flexDirection="column" width={width}>{status}{buttons}</Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={2} width={width}>
        <Box flexShrink={1}>{status}</Box>
        <Box flexGrow={1} />
        {buttons}
      </Box>
    )
    if (!isOpen) return stack(row)

    // Room for the body: the height rule, and never past what the engine gives the band (header + hairline).
    // Show all draws every row: the band grows to all the engine gives (maxRows) and scrolls the rest.
    const cap = b.all ? Infinity : Math.max(3, Math.min(bodyCap(e.viewport?.rows ?? 50), e.props.maxRows - (isNarrow ? 3 : 2)))
    // Push, not overlay: an absolute Box with a negative top is clipped to the band, so it cannot paint over the chat.
    const rule = <Text dimColor wrap="truncate-end">{'─'.repeat(cols)}</Text>
    return stack(<Box flexDirection="column" width={width}>{row}{rule}{body(els, d, act, cap, cols)}</Box>)
  }).catch(($, e, next) => next(e))

  // Escape hands the keys back and the ring leaves our band: show all goes back to normal.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.element && !r.deny && (await read($, band)).all) await update($, band, (x): Band => ({ ...x, all: false }))
    return r
  }).catch(($, e, next) => next(e))
}

// ---- passive observation -------------------------------------------------

function observe(o: Observed, e: ToolCallInput, ran: ToolCallResult): Observed {
  const c = e as Record<string, unknown> & { tool: string }
  const tool = String(c.tool)
  if (tool === 'TodoWrite' && Array.isArray(c.todos)) {
    o = onTodos(o, (c.todos as { content: string; status: Todo['status'] }[]).map(t => ({ text: t.content, status: t.status })))
  } else if (tool === 'TaskCreate' && typeof c.subject === 'string') {
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    const now = o.threads.find(t => t.id === o.current)?.todos ?? []
    o = onTodos(o, [...now, { text: c.subject, status: 'pending', id }])
  } else if (tool === 'TaskUpdate' && typeof c.status === 'string') {
    const status = c.status === 'deleted' ? undefined : (c.status as Todo['status'])
    o = { ...o, threads: o.threads.map(t => ({ ...t, todos: t.todos.flatMap(d => (d.id !== c.taskId ? [d] : status ? [{ ...d, status }] : [])) })) }
  } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && !ran.isError) {
    const path = c.file_path ?? c.notebook_path
    if (typeof path === 'string') o = onEdit(o, path)
  } else if (tool === 'Agent' && typeof c.description === 'string') {
    o = onAgent(o, c.description)
  }
  const cmd = tool === 'Bash' && typeof c.command === 'string' ? c.command : ''
  if (cmd && isTestCommand(cmd)) {
    const r = testResult(cmd, ran.text ?? '', !!ran.isError)
    o = onTest(o, r.ok, r.text)
  } else if (ran.isError) o = onError(o, tool, ran.text ?? 'failed')
  else if (/\bgit\s+commit\b/.test(cmd)) o = onCommit(o, cmd)
  return o
}

/** An Artifact publish (not a list, read or asset upload): its URL and title from the result. */
function published(e: ToolCallInput, ran: ToolCallResult): { url: string; title: string } | undefined {
  const c = e as Record<string, unknown> & { tool: string }
  if (c.tool !== 'Artifact' || ran.isError || c.asset || (c.action ?? 'publish') !== 'publish') return undefined
  const r = (ran.result ?? {}) as { url?: unknown; title?: unknown }
  const url = typeof r.url === 'string' ? r.url : typeof c.url === 'string' ? c.url : undefined
  if (!url) return undefined
  const file = typeof c.file_path === 'string' ? c.file_path.split('/').at(-1)!.replace(/\.\w+$/, '') : ''
  const title = typeof r.title === 'string' ? r.title : typeof c.title === 'string' ? c.title : file
  return { url, title }
}

// ---- views: each returns one element per row, so the band can cut to its height ----

type Els = ReturnType<EngineInterface['ui']['resolve']>
type Acts = { all(): unknown; less?(): unknown; copy(url: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): unknown }
const GLYPH: Record<string, [string, string?]> = {
  completed: ['✓', 'success'], in_progress: ['●', 'suggestion'], active: ['●', 'suggestion'],
  pending: ['○'], remaining: ['○'], blocked: ['✗', 'error'],
}
// Only a clean https URL becomes a terminal link; anything with control characters stays plain text.
export const safeHref = (url: string): string | undefined => {
  if (/[\x00-\x1f\x7f-\x9f]/.test(url)) return undefined
  try { const u = new URL(url); return u.protocol === 'https:' ? u.href : undefined } catch { return undefined }
}
const depth = (o: Observed, t?: Thread): number => (t?.parent ? 1 + depth(o, o.threads.find(x => x.id === t.parent)) : 0)
const byId = (o: Observed, id: number) => o.threads.find(t => t.id === id)
const isOver = (t: Thread) => t.state === 'done' || t.state === 'answered'
const meter = (pct: number, n: number) => '▰'.repeat(Math.round((pct / 100) * n)) + '▱'.repeat(n - Math.round((pct / 100) * n))

/** "just now", "12m ago", "3h ago", "2d ago". */
export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

/** The open band's body for the shown tab, every list cut to `cap` rows (Infinity in the pane). */
function body(els: Els, d: Data, act: Acts, cap: number, cols: number): JSX.Element {
  const { Box, Text } = els
  if (d.tab === 'summary') return summaryView(els, d.cache, cap, act, cols)
  if (d.tab === 'artifacts') return <Box flexDirection="column">{fit(els, artifactRows(els, d.arts, d.now, act, cols), cap, act, 'arts')}</Box>
  const left = timeline(els, d.o, cap, act)
  // A narrow terminal: the list goes under the graph, full width.
  if (cols < 100) return <Box flexDirection="column">{left}<Text> </Text>{threadList(els, d.o, d.now, cols)}</Box>
  // [graph | faint divider | table]; the divider is as tall as the taller side.
  const leftW = Math.max(24, Math.floor(cols * 0.4))
  const tableW = cols - leftW - 2 * DIV_GAP - 1
  const rows = threadList(els, d.o, d.now, tableW)
  const right = fit(els, rows.length ? rows : [<Text dimColor>Nothing yet.</Text>], cap, act, 'threads')
  const tall = Math.max(left.length, right.length)
  return (
    <Box flexDirection="row" gap={DIV_GAP}>
      <Box flexDirection="column" width={leftW}>{left}</Box>
      <Box flexDirection="column" width={1}>{Array.from({ length: tall }, () => <Text dimColor>│</Text>)}</Box>
      <Box flexDirection="column" width={tableW}>{right}</Box>
    </Box>
  )
}
const DIV_GAP = 2

/** At most n rows; the last one says how many were cut, and a press shows them all. */
function fit({ Text, Button }: Els, lines: JSX.Element[], n: number, act: Acts, key: string): JSX.Element[] {
  if (lines.length <= n) return lines
  return [...lines.slice(0, Math.max(0, n - 1)), <Button key={`more-${key}`} plain dimColor label={`+${lines.length - n + 1} more`} onPress={act.all} />]
}

function todoLine({ Text }: Els, d: Todo, note?: string) {
  const [g, color] = GLYPH[d.status] ?? ['○']
  return (
    <Text wrap="truncate-end">
      <Text color={color}>{g}</Text> <Text dimColor={d.status === 'completed'}>{d.text}</Text>{note && <Text dimColor>  {note}</Text>}
    </Text>
  )
}

// ---- timeline: a git graph, one lane per side-trip depth ----

/** lanes: how many lanes are open on this row, so a cut end can draw them all. */
type GraphRow = { rail: string; lanes: number; mark?: string; tone?: string; text?: string; note?: string; strong?: boolean; dim?: boolean }

/**
 * Read like `git log --graph`, oldest first: every row draws every live lane. A side trip forks on its own
 * node ("├─● title"); going back merges on the next row of the thread it returns to ("├─┴─╯ ✗ tests fail").
 */
export function graphRows(o: Observed): GraphRow[] {
  const lane = (d: number) => '│ '.repeat(d)
  const join = (d: number, p: number) => '─┴'.repeat(p - d - 1) + '─╯'
  // A return also logs its prompt; the merge on the next row stands for both.
  const events = o.log
    .filter(a => a.kind !== 'edit' && a.kind !== 'todo')
    .filter((a, i, all) => !(a.kind === 'prompt' && all[i - 1]?.kind === 'return' && all[i - 1]?.thread === a.thread))
    // A tool error right after a failed test of the same thread is that failure again.
    .filter((a, i, all) => !(a.kind === 'error' && all[i - 1]?.kind === 'test' && all[i - 1]?.thread === a.thread && all[i - 1]!.text.startsWith('tests fail')))
  // A thread's tasks sit after its last event: where it stands now.
  const lastAt = new Map<number, number>()
  events.forEach((a, i) => lastAt.set(a.thread, i))
  const rows: GraphRow[] = []
  let prev = -1 // deepest open lane
  let merge: { d: number; p: number } | undefined // a return waiting for its thread's next row
  let nowRow = -1
  const flush = () => {
    if (merge) rows.push({ rail: lane(merge.d) + '├' + join(merge.d, merge.p), lanes: merge.p + 1 })
    merge = undefined
  }
  // A row on lane d's rail; the first one after a return carries the merge.
  const detail = (d: number, r: Omit<GraphRow, 'rail' | 'lanes'>) => {
    if (merge && merge.d !== d) flush()
    if (merge) rows.push({ ...r, rail: lane(d) + '├' + join(d, merge.p) + ' ', lanes: merge.p + 1 })
    else rows.push({ ...r, rail: lane(d + 1), lanes: d + 1 })
    merge = undefined
  }
  events.forEach((a, i) => {
    const t = byId(o, a.thread)
    const d = depth(o, t)
    if (a.kind === 'return') {
      merge = { d, p: Math.max(prev, merge?.p ?? 0) }
      prev = d
    } else if (a.kind === 'prompt') {
      const p = merge?.p ?? prev
      merge = undefined
      if (t?.id === o.current) nowRow = rows.length
      const note = !t || t.state === 'active' ? '' : t.state
      const tone = t && isOver(t) ? 'success' : undefined
      // Fork: "├─● trip". New thread after a side trip with no return: "●─┴─╯ thread".
      const [rail, mark] = p >= 0 && d > p ? [lane(d - 1) + '├─', '●'] : d < p ? [lane(d), '●' + join(d, p)] : [lane(d), '●']
      rows.push({ rail, lanes: Math.max(d, p) + 1, mark, tone, text: t?.title ?? a.text, note })
      prev = d
    } else {
      const bad = a.kind === 'error' || a.text.startsWith('tests fail')
      const mark = a.kind === 'agent' ? '◆' : a.kind === 'commit' ? '◇' : bad ? '✗' : '✓'
      detail(d, { mark, tone: bad ? 'error' : a.kind === 'test' ? 'success' : undefined, text: a.text, dim: !bad })
    }
    // A thread's tasks hang off its rail after its last event.
    if (t && lastAt.get(t.id) === i) {
      for (const d2 of t.todos) {
        const [g, tone] = GLYPH[d2.status] ?? ['○']
        detail(d, { mark: g, tone, text: d2.text, dim: d2.status === 'completed' })
      }
    }
  })
  flush()
  if (nowRow >= 0) rows[nowRow] = { ...rows[nowRow]!, strong: true, tone: 'suggestion' }
  return rows
}

/** The graph in `cap` rows, newest at the bottom next to the prompt; a cut "earlier" end opens the pane. */
function timeline(els: Els, o: Observed, cap: number, act: Acts): JSX.Element[] {
  const { Text, Button } = els
  let rows = graphRows(o)
  const cut = Math.max(0, rows.length - (cap - 2))
  rows = rows.slice(cut)
  // The ends draw every lane open there; a dotted end means the graph goes on past the cut.
  const first = rows[0]?.lanes ?? 1
  const last = rows.at(-1)?.lanes ?? 1
  const earlier = cut
    ? <Button key="earlier" plain dimColor label={`${'┆ '.repeat(first)}earlier · ${cut} more`} onPress={act.all} />
    : act.less
      ? <Button key="earlier" plain dimColor label={`${'╷ '.repeat(first)}earlier · show less`} onPress={act.less} />
      : <Text dimColor wrap="truncate-end">{'╷ '.repeat(first)}earlier</Text>
  const nowEnd = <Text wrap="truncate-end"><Text dimColor>{'╵ '.repeat(last)}</Text><Text color="suggestion" bold>now</Text></Text>
  const lines = rows.map(r => (
    <Text wrap="truncate-end">
      <Text dimColor>{r.rail}</Text>
      {r.mark && <Text color={r.tone}>{r.mark} </Text>}
      {r.text && <Text bold={r.strong} color={r.strong ? 'suggestion' : undefined} dimColor={r.dim}>{r.text}</Text>}
      {r.note && <Text dimColor>  {r.note}</Text>}
    </Text>
  ))
  return [earlier, ...lines, nowEnd]
}

// ---- right of the graph: every thread in the owner's own words ----

const fileName = (p: string) => p.split('/').at(-1)!

/** What a thread did, in its own facts: file names, test counts, the last error, helpers, commits. */
export function didParts(o: Observed, t: Thread): { text: string; error?: string } {
  const mine = o.log.filter(a => a.thread === t.id)
  const parts: string[] = []
  if (t.files.length) parts.push(t.files.slice(0, 3).map(fileName).join(' ') + (t.files.length > 3 ? ` +${t.files.length - 3}` : ''))
  const test = mine.findLast(a => a.kind === 'test')
  if (test) {
    const m = test.text.match(/(\d+) pass, (\d+) fail/)
    parts.push(m ? `tests ${m[1]}/${+m[1]! + +m[2]!}` : test.text.startsWith('tests fail') ? 'tests fail' : 'tests pass')
  }
  const helpers = mine.filter(a => a.kind === 'agent')
  if (helpers.length === 1) parts.push(helpers[0]!.text)
  else if (helpers.length) parts.push(`${helpers.length} helpers`)
  const commits = mine.filter(a => a.kind === 'commit')
  if (commits.length === 1) parts.push(commits[0]!.text)
  else if (commits.length) parts.push(`${commits.length} commits`)
  const err = mine.findLast(a => a.kind === 'error')
  return { text: parts.join(' · '), error: err?.text.replace(/^\w+: /, '') }
}

/** Thread table column widths: the tasks bar with x/y, and each time. */
export const TASK_COL = 12
export const WHEN_COL = 9

/**
 * The threads as a table, under a dim header: status glyph, title, then fixed right-aligned columns
 * (Tasks, Started, Last). Under each title, dim `❯ "<prompt>"` and `⏺ <facts>`, then a red `✗ <failure>`,
 * at the title's left edge and cut before the time columns; the now thread
 * opens with its tasks one step in. The graph on the left shows the side trips, so titles are not indented.
 */
function threadList(els: Els, o: Observed, now: number, w: number): JSX.Element[] {
  const { Box, Text } = els
  if (!o.threads.length) return []
  const cur = byId(o, o.current)
  // The title box ends where the three columns start.
  const titleW = Math.max(10, w - 2 - TASK_COL - 2 * WHEN_COL)
  const cells = (tasks: string, started: string, last: string): [string, string] =>
    [tasks.padStart(TASK_COL), started.padStart(WHEN_COL) + last.padStart(WHEN_COL)]
  // Detail lines may run under Tasks and stop where the times start, so they never touch a time.
  const detailW = w - 2 * WHEN_COL
  const row = (left: JSX.Element, right?: [string, string], tone?: string, dim = false) => (
    <Box flexDirection="row">
      <Box width={right ? 2 + titleW : detailW}>{left}</Box>
      {right && <Text dimColor={dim}><Text color={tone}>{right[0]}</Text><Text dimColor>{right[1]}</Text></Text>}
    </Box>
  )
  const head = row(<Text dimColor>{o.threads.length} threads</Text>, cells('Tasks', 'Started', 'Last'), undefined, true)
  return [head, ...o.threads.flatMap(t => {
    const isNow = t === cur
    const n = t.todos.length
    const ok = t.todos.filter(d => d.status === 'completed').length
    const bar = n > 5 ? meter((ok / n) * 100, 5) : '▰'.repeat(ok) + '▱'.repeat(n - ok)
    const did = didParts(o, t)
    const glyph = isNow ? '▾' : isOver(t) ? '✓' : t.todos.some(d => d.status === 'blocked') || did.error ? '✗' : '▸'
    const tone = isNow ? 'suggestion' : glyph === '✓' ? 'success' : glyph === '✗' ? 'error' : undefined
    return [
      row(
        <Text wrap="truncate-end"><Text color={tone}>{glyph}</Text> <Text bold={isNow} color={isNow ? 'suggestion' : undefined}>{t.title}</Text></Text>,
        cells(n ? `${bar} ${ok}/${n}` : '', t.startedAt === undefined ? '' : ago(now - t.startedAt), isNow ? 'now' : t.lastAt === undefined ? '' : ago(now - t.lastAt)),
        isNow ? 'suggestion' : undefined,
      ),
      // Claude Code's own glyphs: ❯ the owner's prompt, ⏺ what Claude did; both under the title's first letter.
      ...(t.prompt ? [row(<Text dimColor wrap="truncate-end">  ❯ "{snippet(t.prompt)}"</Text>)] : []),
      ...(did.text ? [row(<Text dimColor wrap="truncate-end">  ⏺ {did.text}</Text>)] : []),
      // A failure gets its own red line under what it did, never cut into the middle of it.
      ...(did.error ? [row(<Text color="error" wrap="truncate-end">  ✗ {did.error}</Text>)] : []),
      ...(isNow ? t.todos.map(d => row(<Text wrap="truncate-end">    {todoLine(els, d)}</Text>)) : []),
    ]
  })]
}

// ---- Summary tab: Haiku's estimate, marked as one ----

const ORDER: [Summary['tasks'][number]['status'], string, string?][] = [
  ['completed', 'Done', 'success'], ['active', 'Active', 'suggestion'], ['blocked', 'Stuck', 'error'], ['remaining', 'Left'],
]

/** A board column's least width; under it the columns wrap to the next row (4, 2, then 1 across). */
export const BOARD_MIN = 34
const BOARD_GAP = 3

function summaryView(els: Els, c: SummaryCache, cap: number, act: Acts, cols: number): JSX.Element {
  const { Box, Text } = els
  const s = c.summary
  if (!s) {
    const msg = c.isLoading ? 'Making an estimate…' : c.error ?? 'Opens with an estimate.'
    return <Text color={c.error ? 'error' : undefined} dimColor={!c.error} wrap="truncate-end">{msg}</Text>
  }
  const head = (
    <Text wrap="truncate-end">
      <Text bold>~{s.percent}% done</Text> <Text color="suggestion">{meter(s.percent, 10)}</Text>
      <Text dimColor>  estimate: Haiku's guess from the task list, not measured{c.isLoading ? '  ·  updating…' : ''}</Text>
    </Text>
  )
  // Board: one column per group, the name then its plain line. Columns that do not get BOARD_MIN wrap to the
  // next row, and every row's columns share the full width evenly; work left stays one full-width row.
  const across = Math.max(1, Math.min(ORDER.length, Math.floor(cols / BOARD_MIN)))
  // One column across has the full width: each task and its plain line share one row, so all four groups fit.
  const linesOf = ([st, label, tone]: (typeof ORDER)[number]) => {
    const tasks = s.tasks.filter(t => t.status === st)
    const mark = <Text color={GLYPH[st]?.[1]}>{GLYPH[st]?.[0]}</Text>
    return [
      <Text bold color={tone}>{label} {tasks.length}</Text>,
      ...tasks.flatMap(t => across === 1
        ? [<Text wrap="truncate-end">{mark} {t.name}<Text dimColor>  {t.eli5}</Text></Text>]
        : [<Text wrap="truncate-end">{mark} {t.name}</Text>, <Text dimColor wrap="truncate-end">  {t.eli5}</Text>]),
      ...(st === 'blocked' ? s.blockers.map(x => <Text color="error" wrap="truncate-end">  why: {x}</Text>) : []),
    ]
  }
  const groups = Array.from({ length: Math.ceil(ORDER.length / across) }, (_, i) => ORDER.slice(i * across, (i + 1) * across).map(g => [g[0], linesOf(g)] as const))
  // Every row gets all it needs when the board fits under the head and the work-left row; else an even share.
  const needs = groups.map(g => Math.max(...g.map(([, l]) => l.length)))
  const even = Math.max(2, Math.floor((cap - 2) / groups.length))
  const fits = needs.reduce((a, b) => a + b, 0) <= cap - 2
  const rows = groups.map((group, i) => {
    const w = Math.floor((cols - BOARD_GAP * (group.length - 1)) / group.length)
    return (
      <Box flexDirection="row" gap={BOARD_GAP}>
        {group.map(([st, lines]) => <Box flexDirection="column" width={w}>{fit(els, lines, fits ? needs[i]! : even, act, `board-${st}`)}</Box>)}
      </Box>
    )
  })
  return (
    <Box flexDirection="column">
      {head}
      {rows}
      <Text dimColor wrap="truncate-end">Work left: {s.remaining.join('  ·  ') || 'nothing'}</Text>
    </Box>
  )
}

// ---- Artifacts tab: what this project published, newest change first; a press copies the link ----

/** Width of each time column (Created, Modified), values right-aligned in it. */
export const TIME_COL = 10

/**
 * Two rows per Artifact: the name, then its link (dim), both left; Created and Modified sit in fixed
 * right-aligned columns under a dim header, so every row lines up. Long names and links cut with "…".
 */
function artifactRows(els: Els, rows: ArtifactRow[], now: number, act: Acts, cols: number): JSX.Element[] {
  const { Box, Text, Button, Link } = els
  if (!rows.length) return [<Text dimColor>No Artifacts published from this project yet.</Text>]
  const sorted = [...rows].sort((a, b) => b.modified - a.modified)
  const nameW = Math.max(10, cols - 2 * TIME_COL)
  // A dim dot on the name and a hook to its link tie the two lines; fixed width, so the columns never move.
  const mark = (g: string) => <Text dimColor>{g}</Text>
  const right = (a: string, b: string) => a.padStart(TIME_COL) + b.padStart(TIME_COL)
  const row = (left: JSX.Element, times: string, dim = false) => (
    <Box flexDirection="row">
      <Box width={nameW}>{left}</Box>
      <Text dimColor={dim}>{times}</Text>
    </Box>
  )
  return [
    row(<Text dimColor wrap="truncate-end">  {rows.length} Artifacts  ·  click copies the link</Text>, right('Created', 'Modified'), true),
    ...sorted.flatMap((r, i) => [
      row(
        <Box flexDirection="row">{mark('● ')}<Button key={`art-${i}`} plain label={short(r.title, nameW - 4)} onPress={p => act.copy(r.url, p.surface)} /></Box>,
        right(ago(now - r.created), ago(now - r.modified)),
      ),
      // 🔗 is 2 columns wide: the link is cut 3 columns sooner (with its space).
      row(<Text>{mark('╰╴')}🔗 {safeHref(r.url) ? <Link href={safeHref(r.url)!}><Text dimColor>{short(r.url, nameW - 7)}</Text></Link> : <Text dimColor>{short(r.url, nameW - 7)}</Text>}</Text>, ''),
    ]),
  ]
}
