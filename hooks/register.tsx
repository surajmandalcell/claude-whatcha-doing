import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ArtifactRow, Artifacts, Band, Observed, Summary, SummaryCache, Tab, Thread, Todo } from '../types'
import {
  demoArtifacts, demoObserved, demoSummary, emptyObserved, hash, isTestCommand, onAgent, onArtifact, onCommit, onEdit,
  dropEngineText, isEngineText, noticeOf, onNotice, onError, onPlan, onPrompt, onTest, onTodos, onTurnEnd, parseSummary, sentLabel, short, stamp, testResult, SUMMARY_SYSTEM, summaryInput,
  summaryPrompt, SUMMARY_OUT, NAME_SYSTEM, threadName,
} from './observe'
import { onDevice } from './ondevice'

// Change a tag when that value's fields change: it declines what an older version stored.
const observed = atom({ plugin: 'whatcha-doing', key: 'observed' } as const, emptyObserved, { shape: 'observed-2' })
const tabAtom = atom({ plugin: 'whatcha-doing', key: 'tab' } as const, 'threads' as Tab, { shape: 'tab-3' })
const summary = atom({ plugin: 'whatcha-doing', key: 'summary' } as const, { key: '' } as SummaryCache, { shape: 'summary-2' })
const demo = atom({ plugin: 'whatcha-doing', key: 'isDemo' } as const, false, { shape: 'demo-1' })
const band = atom({ plugin: 'whatcha-doing', key: 'band' } as const, { mode: 'collapsed' } as Band, { shape: 'band-2' })
const artifacts = atom({ plugin: 'whatcha-doing', key: 'artifacts' } as const, { key: '', rows: [] } as Artifacts, { shape: 'artifacts-1' })
/** L body rows: 20% of the terminal, at most 80 and at least 3; the engine's maxRows caps it too. */
export const bodyCap = (rows: number) => Math.max(3, Math.min(80, Math.floor(rows * 0.2)))
/** M body rows: the few most useful lines of the shown tab. */
export const COMPACT_ROWS = 4
const TABS: [Tab, string][] = [['threads', 'Threads'], ['summary', 'Summary'], ['artifacts', 'Artifacts']]
const SIZES: [Band['mode'], string][] = [['collapsed', 'S'], ['compact', 'M'], ['expanded', 'L']]

// A hook may not pass `$` on, so each hook spells these closures itself.
type SummaryIo = {
  state(): Promise<[isDemo: boolean, o: Observed, was: SummaryCache]>
  set(c: SummaryCache): Promise<unknown>
  complete(r: ModelCompleteRequest): Promise<ModelCompleteResult>
  now(): Promise<number>
  /** Redraws the band every second while Haiku runs, so the progress bar moves; returns what stops it. */
  tick(): () => void
}

/** The one place a model is called: only when the Summary tab is shown, or on Refresh. */
async function showSummary(io: SummaryIo, force = false) {
  const [isDemo, o, was] = await io.state()
  if (isDemo) return
  const input = summaryInput(o)
  const key = hash(input)
  if (was.isLoading || (!force && was.key === key)) return
  if (o.threads.length === 0) return void (await io.set({ key, error: 'Nothing to sum up yet.' }))
  await io.set({ key, summary: was.summary, isLoading: true, startedAt: await io.now() })
  const stop = io.tick()
  const r = await io.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: summaryPrompt(input), maxTokens: SUMMARY_OUT, timeoutMs: 30000 }).finally(stop)
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
      description: 'Open the Whatcha doing band (threads, summary, artifacts, compact, all, close, min, demo, live)',
      argumentHint: '[open|threads|summary|artifacts|compact|all|close|min|demo|live]',
    })
    if ((await $.env.get('WHATCHA_DEMO')) === '1') await update($, demo, () => true)
    await update($, observed, dropEngineText).catch(() => {})
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
      now: () => $.clock.now(),
      tick: () => { const t = $.clock.every(1000, () => $.ui.invalidate('ui.render')); return () => t.cancel() },
    }
    const [arg = 'open'] = e.args.trim().split(/\s+/).filter(Boolean)
    const tab = TABS.find(([id]) => id === arg)?.[0]
    if (arg === 'demo' || arg === 'live') await update($, demo, () => arg === 'demo')
    else if (arg === 'close' || arg === 'min') await update($, band, (b): Band => ({ ...b, mode: arg === 'min' ? 'min' : 'collapsed', all: false }))
    else if (arg === 'all') await update($, band, (x): Band => ({ ...x, mode: 'expanded', all: !x.all }))
    else {
      if (tab) await update($, tabAtom, () => tab)
      await update($, band, (x): Band => ({ ...x, mode: arg === 'compact' ? 'compact' : 'expanded', all: false }))
      if ((await read($, tabAtom)) === 'summary') await showSummary(io)
    }
    // The band itself shows the result: an output line per command only stacked noise above it.
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    const notice = noticeOf(e.text)
    if (notice || (!e.command && !e.isMeta && !isEngineText(e.text))) {
      const at = await $.clock.now()
      const o = await update($, observed, x => stamp(notice ? onNotice(x, notice) : onPrompt(x, e.text), at, !notice))
      // A new thread's first prompt: the on-device model names it in the background; the prompt never waits.
      const t = byId(o, o.current)
      if (!notice && t && !t.name && o.log.filter(a => a.kind === 'prompt' && a.thread === t.id).length === 1) {
        const host = {
          plugin: { root: $.plugin.root },
          // The engine wants a literal name here; HOME is the only one onDevice reads.
          env: { get: () => $.env.get('HOME') },
          fs: { read: (p: string) => $.fs.read(p), exists: (p: string) => $.fs.exists(p) },
          process: { run: (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, opts) },
        } as unknown as Parameters<typeof onDevice>[0]
        void onDevice(host, NAME_SYSTEM, e.text.slice(0, 2000))
          .then(r => threadName(r))
          .then(name => name === undefined ? undefined : update($, observed, x => ({ ...x, threads: x.threads.map(y => (y.id === t.id ? { ...y, name } : y)) })))
          .catch(() => {})
      }
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
    if (!e.agentId && (await read($, tabAtom)) === 'summary' && ['compact', 'expanded'].includes((await read($, band)).mode)) {
      void showSummary({
        state: async () => [await read($, demo), await read($, observed), await read($, summary)],
        set: c => update($, summary, () => c),
        complete: q => $.model.complete(q),
        now: () => $.clock.now(),
        tick: () => { const t = $.clock.every(1000, () => $.ui.invalidate('ui.render')); return () => t.cancel() },
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
      now: () => $.clock.now(),
      tick: () => { const t = $.clock.every(1000, () => $.ui.invalidate('ui.render')); return () => t.cancel() },
    }
    const cols = e.props.bodyColumns
    const width = e.surface === 'terminal' ? cols : undefined
    const stack = (mine: NonNullable<typeof below>) => (below ? <Box flexDirection="column">{mine}{below}</Box> : mine)
    const setMode = (mode: Band['mode']) => update($, band, (x): Band => ({ ...x, mode, all: false }))
    const open = async (t: Tab) => {
      await update($, tabAtom, () => t)
      // A tab keeps a Compact band compact; from the one row it opens to Regular.
      await update($, band, (x): Band => ({ ...x, mode: x.mode === 'compact' ? 'compact' : 'expanded', all: false }))
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
    const isOpen = b.mode === 'expanded' || b.mode === 'compact'
    // Under 120 columns the buttons do not fit beside the status: they take a row of their own.
    const isNarrow = cols < 120
    const status = (
      <Text wrap="truncate-end">
        <Text color="suggestion">●</Text> Now ({over}/{o.threads.length}): <Text bold>{now ? nameOf(now) : 'waiting for the first prompt'}</Text>
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
        {/* The three sizes, the shown one bold in the accent color like a tab; a space each side makes a 3-wide target. */}
        {SIZES.map(([mode, label]) => (
          <Button key={`size-${mode}`} label={` ${label} `} plain onPress={() => setMode(mode)}>
            {b.mode === mode ? <Text bold color="suggestion">{` ${label} `}</Text> : ` ${label} `}
          </Button>
        ))}
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
    const main = b.mode === 'compact' ? <Box flexDirection="column">{brief(els, d, act, cols)}</Box> : body(els, d, act, cap, cols)
    return stack(<Box flexDirection="column" width={width}>{row}{rule}{main}</Box>)
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
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (tool === 'TodoWrite' && Array.isArray(c.todos)) {
    o = onTodos(o, (c.todos as { content: string; status: Todo['status']; activeForm?: string }[]).map(t => ({ text: t.content, status: t.status, activeForm: str(t.activeForm) })))
  } else if (tool === 'TaskCreate' && typeof c.subject === 'string') {
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    const now = o.threads.find(t => t.id === o.current)?.todos ?? []
    o = onTodos(o, [...now, { text: c.subject, status: 'pending', id, activeForm: str(c.activeForm), description: str(c.description) }])
  } else if (tool === 'TaskUpdate' && typeof c.taskId === 'string') {
    const status = c.status === 'deleted' ? undefined : (str(c.status) as Todo['status'] | undefined)
    const edit = (d: Todo): Todo[] => {
      if (d.id !== c.taskId) return [d]
      if (c.status === 'deleted') return []
      return [{ ...d, status: status ?? d.status, text: str(c.subject) ?? d.text, activeForm: str(c.activeForm) ?? d.activeForm, description: str(c.description) ?? d.description }]
    }
    o = { ...o, threads: o.threads.map(t => ({ ...t, todos: t.todos.flatMap(edit) })) }
  } else if (tool === 'ExitPlanMode' || (tool === 'Write' && /\/\.claude\/plans\/[^/]+\.md$/.test(str(c.file_path) ?? ''))) {
    // The plan is in the call (plan), or in the plan file Claude writes before asking to leave plan mode.
    const md = str(c.plan) ?? str((ran.result as { plan?: unknown } | undefined)?.plan) ?? (tool === 'Write' ? str(c.content) : undefined)
    if (md) o = onPlan(o, md)
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
  if (d.tab === 'summary') return summaryView(els, d.cache, cap, act, cols, d.now)
  if (d.tab === 'artifacts') return <Box flexDirection="column">{fit(els, artifactRows(els, d.arts, d.now, act, cols), cap, act, 'arts')}</Box>
  const rows = threadRows(els, d.o)
  // A narrow terminal: the running task goes under the threads, full width.
  if (cols < 100) {
    const all = rows.length ? [...rows, <Text> </Text>, ...taskDetail(els, d.o, cols)] : [<Text dimColor>Nothing yet.</Text>]
    return <Box flexDirection="column">{fit(els, all, cap, act, 'threads')}</Box>
  }
  // [threads | faint divider | running task]; the divider is as tall as the taller side.
  const leftW = Math.floor(cols * 0.6)
  const rightW = cols - leftW - 2 * DIV_GAP - 1
  const left = fit(els, rows.length ? rows : [<Text dimColor>Nothing yet.</Text>], cap, act, 'threads')
  const right = fit(els, taskDetail(els, d.o, rightW), cap, act, 'task')
  const tall = Math.max(left.length, right.length)
  return (
    <Box flexDirection="row" gap={DIV_GAP}>
      <Box flexDirection="column" width={leftW}>{left}</Box>
      <Box flexDirection="column" width={1}>{Array.from({ length: tall }, () => <Text dimColor>│</Text>)}</Box>
      <Box flexDirection="column" width={rightW}>{right}</Box>
    </Box>
  )
}
const DIV_GAP = 2

/**
 * The Compact body: the shown tab's most useful COMPACT_ROWS lines. Threads: the newest graph rows.
 * Summary: the head (or the updating bar), what is active or stuck, and the work left. Artifacts: the newest one.
 */
function brief(els: Els, d: Data, act: Acts, cols: number): JSX.Element[] {
  const { Text } = els
  if (d.tab === 'artifacts') return artifactRows(els, d.arts, d.now, act, cols).slice(0, COMPACT_ROWS)
  if (d.tab === 'threads') {
    // The current thread's head stays pinned on top, full width; its sub rows scroll under it as work moves on.
    const t = byId(d.o, d.o.current)
    if (!t) return [<Text dimColor>Nothing yet.</Text>]
    const b = threadBlock(els, d.o, t)
    return [b.lead, ...b.sub.slice(0, COMPACT_ROWS - 1)]
  }
  const s = d.cache.summary
  if (!s) return [summaryView(els, d.cache, COMPACT_ROWS, act, cols, d.now)]
  const names = (st: string) => s.tasks.filter(t => t.status === st).map(t => t.name)
  const stuck = names('blocked')
  return [
    <Text wrap="truncate-end">
      <Text bold>~{s.percent}% done</Text> <Text color="suggestion">{meter(s.percent, 10)}</Text><Text dimColor>  Haiku's estimate</Text>
    </Text>,
    d.cache.isLoading ? updatingBar(els, d.cache, cols, d.now) : (
      <Text wrap="truncate-end">
        <Text color="suggestion">●</Text> Active: {names('active').join('  ·  ') || 'nothing'}
        {stuck.length > 0 && <Text color="error">  ✗ Stuck: {stuck.join('  ·  ')}</Text>}
      </Text>
    ),
    <Text dimColor wrap="truncate-end">Work left: {s.remaining.join('  ·  ') || 'nothing'}</Text>,
  ]
}

/** At most n rows; the last one says how many were cut, and a press shows them all. */
function fit({ Text, Button }: Els, lines: JSX.Element[], n: number, act: Acts, key: string): JSX.Element[] {
  if (lines.length <= n) return lines
  return [...lines.slice(0, Math.max(0, n - 1)), <Button key={`more-${key}`} plain dimColor label={`+${lines.length - n + 1} more`} onPress={act.all} />]
}

// ---- Threads tab: each thread with its tasks and plan steps; beside it, the running task in detail ----

/** A thread's shown name: the on-device model's, else the title from the first prompt. */
const nameOf = (t: Thread) => t.name ?? t.title
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`
const rank = (o: Observed, t: Thread) => (t.id === o.current ? 0 : isOver(t) ? 2 : 1)
/** The current thread first, then open ones, then finished ones; newest first in each group. */
export const ordered = (o: Observed) => [...o.threads].reverse().sort((a, b) => rank(o, a) - rank(o, b))
const running = (t: Thread) => t.todos.find(d => d.status === 'in_progress')

/** "11 tests pass · 1 fails · 2 files · 1 commit": plain counts from the thread's own log, no model. */
export function resultParts(o: Observed, t: Thread): [string, string?][] {
  const mine = o.log.filter(a => a.thread === t.id)
  const out: [string, string?][] = []
  const test = mine.findLast(a => a.kind === 'test')
  if (test) {
    const m = test.text.match(/(\d+) pass, (\d+) fail/)
    const bad = test.text.startsWith('tests fail')
    if (m) out.push([`${m[1]} tests pass`, 'success'], ...(+m[2]! ? [[`${m[2]} fails`, 'error'] as [string, string]] : []))
    else out.push([bad ? 'tests fail' : 'tests pass', bad ? 'error' : 'success'])
  }
  if (t.files.length) out.push([plural(t.files.length, 'file')])
  const commits = mine.filter(a => a.kind === 'commit').length
  if (commits) out.push([plural(commits, 'commit')])
  return out
}

/** Indents: a thread at 0, its tasks and Claude's line at 2, plan steps and results at 4, nested steps 2 deeper each. */
const IN = (n: number) => ' '.repeat(n)

/**
 * One thread as rows, each its own line: the head (glyph, name, state; progress at the right edge),
 * `❯ <activeForm>…` of the running task, the results line, then every task, then the plan's steps.
 * `lead` is the head; `sub` are the rest, the running task's lines first (M shows the first 3).
 */
function threadBlock(els: Els, o: Observed, t: Thread): { lead: JSX.Element; sub: JSX.Element[]; items: JSX.Element[] } {
  const { Box, Text } = els
  const isNow = t.id === o.current
  const n = t.todos.length
  const ok = t.todos.filter(d => d.status === 'completed').length
  const steps = (t.plan ?? []).filter(s => s.mark !== '#' && s.depth === 0).length
  const hasFail = t.todos.some(d => d.status === 'blocked')
  const [g, tone] = isNow ? ['▸', 'suggestion'] : isOver(t) ? ['✓', 'success'] : hasFail ? ['✗', 'error'] : ['■']
  const progress = n ? `${ok} of ${n} done` : steps ? `plan · ${plural(steps, 'step')}` : ''
  const lead = (
    <Box flexDirection="row" gap={2}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={tone}>{g}</Text> <Text bold color={isNow ? 'suggestion' : undefined}>{nameOf(t)}</Text>
          <Text dimColor>  ·  {isNow ? 'now' : t.state}</Text>
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>{[progress, t.sentAt === undefined ? '' : sentLabel(t.sentAt)].filter(Boolean).join('  ·  ')}</Text>
    </Box>
  )
  const run = running(t)
  const results = resultParts(o, t)
  const lines = [
    ...(run ? [<Text wrap="truncate-end">{IN(2)}<Text dimColor>❯ </Text><Text color="suggestion">{run.activeForm ?? run.text}…</Text></Text>] : []),
    ...(results.length ? [
      <Text wrap="truncate-end">{IN(4)}{results.map(([s, c], i) => <Text>{i ? <Text dimColor>{'  ·  '}</Text> : ''}<Text color={c} dimColor={!c}>{s}</Text></Text>)}</Text>,
    ] : []),
  ]
  const tasks = t.todos.map(d => {
    const [mark, color] = GLYPH[d.status] ?? ['○']
    return <Text wrap="truncate-end">{IN(2)}<Text color={color}>{mark}</Text> <Text dimColor={d.status === 'completed'}>{d.text}</Text></Text>
  })
  let underHeading = false
  const plan = t.plan?.length ? [
    <Text dimColor wrap="truncate-end">{IN(2)}Plan · {plural(steps, 'step')}</Text>,
    ...t.plan.map(s => {
      if (s.mark === '#') {
        underHeading = true
        return <Text bold dimColor wrap="truncate-end">{IN(4)}{s.text}</Text>
      }
      return <Text wrap="truncate-end">{IN(4 + 2 * (s.depth + (underHeading ? 1 : 0)))}<Text dimColor>{s.mark}</Text> {s.text}</Text>
    }),
  ] : []
  // M scrolls from the running task: the done ones above it are history.
  const from = Math.max(0, t.todos.findIndex(d => d.status !== 'completed'))
  return { lead, sub: [...lines, ...tasks.slice(from), ...plan], items: [...lines, ...tasks, ...plan] }
}

/** Every thread's rows, a blank row between threads. */
function threadRows(els: Els, o: Observed): JSX.Element[] {
  const { Text } = els
  return ordered(o).flatMap((t, i) => {
    const b = threadBlock(els, o, t)
    return [...(i ? [<Text> </Text>] : []), b.lead, ...b.items]
  })
}

/** Plain word wrap to `w` columns; a word longer than a line is cut. */
export function wrap(s: string, w: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && line.length + 1 + word.length > w) { out.push(line); line = '' }
    line = line ? `${line} ${word}` : word.slice(0, w)
  }
  return line ? [...out, line] : out
}

/** The current thread's running task in full: its name, Claude's activeForm, the TaskCreate description, and what is next. */
function taskDetail(els: Els, o: Observed, w: number): JSX.Element[] {
  const { Box, Text } = els
  const t = byId(o, o.current)
  if (!t) return [<Text dimColor>Nothing yet.</Text>]
  const run = running(t)
  const at = run ? t.todos.indexOf(run) : -1
  const next = t.todos.find((d, i) => i > at && d.status === 'pending')?.text ?? t.plan?.find(s => s.mark !== '#')?.text
  const kv = (k: string, v: string) => (
    <Box flexDirection="row" gap={2}><Text dimColor>{k}</Text><Box flexShrink={1}><Text wrap="truncate-end">{v}</Text></Box></Box>
  )
  const head = (
    <Box flexDirection="row" gap={2}>
      <Box flexShrink={1}><Text bold wrap="truncate-end">Now: {run ? run.text : nameOf(t)}</Text></Box>
      <Box flexGrow={1} />
      {run && <Text dimColor>task {at + 1} of {t.todos.length}</Text>}
    </Box>
  )
  if (!run) return [head, <Text dimColor>No task running.</Text>, ...(next ? [<Text> </Text>, kv('next', next)] : [])]
  return [
    head,
    <Text bold color="suggestion" wrap="truncate-end">{run.activeForm ?? run.text}…</Text>,
    ...(run.description ? [<Text> </Text>, ...wrap(run.description, w).map(l => <Text>{l}</Text>)] : []),
    ...(next ? [<Text> </Text>, kv('next', next)] : []),
  ]
}

// ---- Summary tab: Haiku's estimate, marked as one ----

const ORDER: [Summary['tasks'][number]['status'], string, string?][] = [
  ['completed', 'Done', 'success'], ['active', 'Active', 'suggestion'], ['blocked', 'Stuck', 'error'], ['remaining', 'Left'],
]

/** A board column's least width; under it the columns wrap to the next row (4, 2, then 1 across). */
export const BOARD_MIN = 34
const BOARD_GAP = 3

/** While Haiku runs: a thin line that fills over the usual ~8 s a reply takes, never reaching the end first. */
function updatingBar({ Text }: Els, c: SummaryCache, cols: number, now: number): JSX.Element {
  const secs = Math.max(0, Math.round((now - (c.startedAt ?? now)) / 1000))
  const n = Math.max(10, cols - 26)
  const full = Math.min(n - 1, Math.round((secs / 8) * n * 0.9))
  return (
    <Text wrap="truncate-end">
      <Text color="suggestion">{'━'.repeat(full)}╸</Text><Text dimColor>{'─'.repeat(n - full - 1)}</Text>
      <Text color="suggestion">  updating with Haiku  {secs} s</Text>
    </Text>
  )
}

function summaryView(els: Els, c: SummaryCache, cap: number, act: Acts, cols: number, now: number): JSX.Element {
  const { Box, Text } = els
  const s = c.summary
  if (!s) {
    if (c.isLoading) return updatingBar(els, c, cols, now)
    return <Text color={c.error ? 'error' : undefined} dimColor={!c.error} wrap="truncate-end">{c.error ?? 'Opens with an estimate.'}</Text>
  }
  const head = (
    <Text wrap="truncate-end">
      <Text bold>~{s.percent}% done</Text> <Text color="suggestion">{meter(s.percent, 10)}</Text>
      <Text dimColor>  estimate: Haiku's guess from the task list, not measured</Text>
    </Text>
  )
  // The bar takes a row of the board's room while it shows.
  const bar = c.isLoading ? updatingBar(els, c, cols, now) : undefined
  if (bar) cap -= 1
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
      {bar}
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
