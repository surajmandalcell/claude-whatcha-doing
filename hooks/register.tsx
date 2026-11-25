import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, SessionMessage, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ArtifactRow, Artifacts, Band, Observed, Summary, SummaryCache, Tab, Thread, Todo } from '../types'
import {
  demoArtifacts, demoObserved, demoSummary, emptyObserved, hash, isTestCommand, onAgent, onArtifact, onCommit, onEdit,
  dropEngineText, isEngineText, noticeOf, promptLine, untag, onNotice, onError, onPlan, onPrompt, onTest, onTodos, onTurnEnd, parseSummary, sentLabel, short, stamp, unlist, testResult, SUMMARY_SYSTEM, summaryInput,
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
/** L body rows: 20% of the terminal, at most 22 and at least 3; the engine's maxRows caps it too. */
export const bodyCap = (rows: number) => Math.max(3, Math.min(22, Math.floor(rows * 0.2)))
/** M body rows: the few most useful lines of the shown tab. */
export const COMPACT_ROWS = 5
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
    // Loaded mid-session (a reload, a resume): the transcript holds prompts we never saw, so rebuild from it.
    const msgs = await $.session.messages().catch(() => undefined)
    if (Array.isArray(msgs)) {
      await update($, observed, o => {
        if (promptsIn(msgs) <= o.log.filter(a => a.kind === 'prompt').length) return o
        const r = replay(msgs)
        // Keep the on-device names and send times of threads we already knew.
        return { ...r, threads: r.threads.map(t => ({ ...o.threads.find(x => x.title === t.title), ...t })) }
      }).catch(() => {})
    }
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
        void onDevice(host, NAME_SYSTEM, untag(e.text).slice(0, 2000))
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
    const setMode = (mode: Band['mode']) => update($, band, (x): Band => ({ ...x, mode, all: false, scroll: 0 }))
    const open = async (t: Tab) => {
      await update($, tabAtom, () => t)
      // A tab keeps a Compact band compact; from the one row it opens to Regular.
      await update($, band, (x): Band => ({ ...x, mode: x.mode === 'compact' ? 'compact' : 'expanded', all: false, scroll: 0 }))
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
    const now = byId(o, o.current)
    const over = o.threads.filter(isOver).length
    const isOpen = b.mode === 'expanded' || b.mode === 'compact'
    // Under 120 columns the buttons do not fit beside the status: they take a row of their own.
    const isNarrow = cols < 120
    // Room for the body: the height rule, and never past what the engine gives the band (header + hairline).
    // Show all draws every row: the band grows to all the engine gives (maxRows) and scrolls the rest.
    const cap = b.all ? Infinity : Math.max(3, Math.min(bodyCap(e.viewport?.rows ?? 50), e.props.maxRows - (isNarrow ? 3 : 2)))
    // M's rows: 5, and never past the engine's maxRows less the header and hairline (a taller tree scrolls, hiding rows).
    const mRows = Math.max(1, Math.min(COMPACT_ROWS, e.props.maxRows - (isNarrow ? 3 : 2)))
    // How far ▲ ▼ move the timeline: whenever it is taller than the shown rows.
    const room = !isOpen || tab !== 'threads' || b.all ? 0 : roomOf(timeline(els, o).rows.length, b.mode === 'compact' ? mRows : cap)
    const off = Math.min(b.scroll ?? 0, room)
    const scrollTo = (n: number) => update($, band, (x): Band => ({ ...x, scroll: n }))
    // 3 columns wide like the sizes; an arrow that cannot move stays in place, dim, so nothing shifts.
    const arrow = (key: string, glyph: string, can: boolean, to: number) =>
      can ? <Button key={key} plain label={` ${glyph} `} onPress={() => scrollTo(to)} /> : <Text dimColor>{` ${glyph} `}</Text>
    const [g, tone] = now ? headGlyph(o, now) : ['●', 'suggestion']
    const status = (
      <Text wrap="truncate-end">
        <Text color={tone}>{g}</Text> Now ({over}/{o.threads.length}): <Text bold>{now ? nameOf(now) : 'waiting for the first prompt'}</Text>
      </Text>
    )
    const buttons = (
      <Box flexDirection="row" gap={isNarrow ? 1 : 2}>
        {!isNarrow && <Text dimColor>│</Text>}
        {room > 0 && arrow('up', '▲', off > 0, off - 1)}
        {room > 0 && arrow('down', '▼', off < room, off + 1)}
        {/* No hotkey labels: keys go to the prompt, the band takes clicks. */}
        {TABS.map(([id, label]) => (
          // Dim tabs read as disabled: every tab is full text, the open one bold in the accent color.
          <Button key={`tab-${id}`} label={label} plain onPress={() => open(id)}>
            {isOpen && tab === id ? <Text bold color="suggestion">{label}</Text> : label}
          </Button>
        ))}
        {isOpen && tab === 'summary' && <Button key="refresh" plain label=" ↻ " onPress={() => showSummary(io, true)} />}
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
      <Box flexDirection="row" alignItems="center" gap={1} width={width}>
        {/* The title takes every column up to the │ before the tabs. */}
        <Box flexGrow={1} flexShrink={1}>{status}</Box>
        {buttons}
      </Box>
    )
    if (!isOpen) return stack(row)

    // Push, not overlay: an absolute Box with a negative top is clipped to the band, so it cannot paint over the chat.
    const rule = <Text dimColor wrap="truncate-end">{'─'.repeat(cols)}</Text>
    const main = b.mode === 'compact' ? <Box flexDirection="column">{brief(els, d, act, cols, off, mRows)}</Box> : body(els, d, act, cap, cols, off)
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

/** Prompts the band rebuilds from the transcript at most: the newest ones. */
export const REPLAY_PROMPTS = 200
/** A person's prompt or a task report in the transcript; tool results and engine text are not. */
const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && !m.toolResults?.length && m.text.trim() !== '' && (!isEngineText(m.text) || !!noticeOf(m.text))
const promptsIn = (msgs: SessionMessage[]) => msgs.filter(m => isPrompt(m) && !noticeOf(m.text)).length

/**
 * The threads rebuilt from the session's transcript, for what happened before the mod loaded: each prompt,
 * then its tool calls, through the same steps as live. The transcript has no times, so no `sent` cell.
 */
export function replay(msgs: SessionMessage[]): Observed {
  const starts = msgs.flatMap((m, i) => (isPrompt(m) && !noticeOf(m.text) ? [i] : []))
  let o = emptyObserved
  for (const m of msgs.slice(starts.at(-REPLAY_PROMPTS) ?? 0)) {
    if (m.role === 'assistant') {
      for (const u of m.toolUses) o = observe(o, { ...u.input, tool: u.tool } as unknown as ToolCallInput, u as unknown as ToolCallResult)
    } else if (isPrompt(m)) {
      const notice = noticeOf(m.text)
      // A new prompt means the turn before it ended with an answer.
      o = notice ? onNotice(o, notice) : onPrompt(onTurnEnd(o, true), m.text)
    }
  }
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
function body(els: Els, d: Data, act: Acts, cap: number, cols: number, off: number): JSX.Element {
  const { Box } = els
  if (d.tab === 'summary') return summaryView(els, d.cache, cap, act, cols, d.now)
  if (d.tab === 'artifacts') return <Box flexDirection="column">{fit(els, artifactRows(els, d.arts, d.now, act, cols), cap, act, 'arts')}</Box>
  // One timeline at the full width; ▲ ▼ move it under the pinned head, "+N more" shows every row.
  return <Box flexDirection="column">{fit(els, threadWindow(els, d.o, cap === Infinity ? 0 : off), cap, act, 'threads')}</Box>
}

/**
 * The Compact body: the shown tab's most useful n lines. Threads: the timeline window under its pinned head.
 * Summary: the head (or the updating bar), what is active or stuck, and the work left. Artifacts: the newest one.
 */
function brief(els: Els, d: Data, act: Acts, cols: number, off: number, n: number): JSX.Element[] {
  const { Text } = els
  if (d.tab === 'artifacts') return artifactRows(els, d.arts, d.now, act, cols).slice(0, n)
  if (d.tab === 'threads') return threadWindow(els, d.o, off).slice(0, n)
  const s = d.cache.summary
  if (!s) return [summaryView(els, d.cache, n, act, cols, d.now)]
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

// ---- Threads tab: one timeline, each thread with its tasks and plan steps ----

/** A thread's shown name: the on-device model's (checked again, so a fragment saved before 1.0.18 drops), else the title. */
const nameOf = (t: Thread) => (t.name ? threadName(t.name) : undefined) ?? unlist(untag(t.title))
/** One glyph per thread state, the same in S, M and L: ▸ now, ✓ done, ✗ stuck, ⏸ paused. */
const headGlyph = (o: Observed, t: Thread): [string, string?] =>
  t.id === o.current ? ['▸', 'suggestion'] : isOver(t) ? ['✓', 'success']
    : t.todos.some(d => d.status === 'blocked') ? ['✗', 'error'] : t.state === 'paused' ? ['⏸'] : ['▸']
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`
const rank = (o: Observed, t: Thread) => (t.id === o.current ? 0 : isOver(t) ? 2 : 1)
/** The current thread first, then open ones, then finished ones; newest first in each group. */
export const ordered = (o: Observed) => [...o.threads].reverse().sort((a, b) => rank(o, a) - rank(o, b))
const running = (t: Thread) => t.todos.find(d => d.status === 'in_progress')

/** "sent 10:42", "1 commit", "3 files", "11 pass · 1 fail": the 4 right-hand columns of a thread's row, plain counts from its own log. */
type Part = [string, string?]
export function metaOf(o: Observed, t: Thread): Part[][] {
  const mine = o.log.filter(a => a.thread === t.id)
  const test = mine.findLast(a => a.kind === 'test')
  const m = test?.text.match(/(\d+) pass, (\d+) fail/)
  const tests: Part[] = !test ? []
    : m ? [[`${m[1]} pass`, 'success'], ...(+m[2]! ? [[' · '], [`${m[2]} fail`, 'error']] as Part[] : [])]
    : [] // no count read from the run: an empty cell, never a bare "tests pass"
  const commits = mine.filter(a => a.kind === 'commit').length
  return [t.sentAt === undefined ? [] : [[sentLabel(t.sentAt)]], commits ? [[plural(commits, 'commit')]] : [], t.files.length ? [[plural(t.files.length, 'file')]] : [], tests]
}
const lenOf = (c: Part[]) => c.reduce((a, [s]) => a + [...s].length, 0)
/** The column separator: much fainter than dim, barely there on the dark background. */
const FAINT = '#3a3a3a'

/** A thread's work rows, by log kind: the mark and its color (none: dim). */
const WORK: Partial<Record<Observed['log'][number]['kind'], [string, string?]>> = {
  edit: ['✎'], test: ['✓', 'success'], commit: ['◆'], agent: ['↳'],
}

/** Indents: a thread at 0, its tasks and Claude's line at 2, plan steps at 4, nested steps 2 deeper each. */
const IN = (n: number) => ' '.repeat(n)

/**
 * One thread as rows, each its own line: the head (glyph, name, then the meta columns at `widths`), the later
 * prompts (`› <prompt> · 12:07`, the last 3, newest lowest), `❯ <activeForm>…` of the running task, every task
 * (or with no tasks, the last 3 things done: edits, test runs, commits, helpers), then the plan, folded to
 * "Plan · N steps" unless current. So a new prompt and new work always show near the head.
 */
function threadBlock(els: Els, o: Observed, t: Thread, widths: number[]): JSX.Element[] {
  const { Box, Text } = els
  const isNow = t.id === o.current
  const steps = (t.plan ?? []).filter(s => s.mark !== '#' && s.depth === 0).length
  const [g, tone] = headGlyph(o, t)
  const meta = metaOf(o, t)
  const lead = (
    <Box flexDirection="row">
      {/* The name takes every column up to the first meta column. */}
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end"><Text color={tone}>{g}</Text> <Text bold color={isNow ? 'suggestion' : undefined}>{nameOf(t)}</Text></Text>
      </Box>
      {widths.map((w, i) => w > 0 && (
        <Text><Text color={FAINT}>{' ┊ '}</Text>{' '.repeat(w - lenOf(meta[i]!))}{meta[i]!.map(([s, c]) => <Text color={c} dimColor={!c}>{s}</Text>)}</Text>
      ))}
    </Box>
  )
  const run = running(t)
  const tasks = t.todos.map(d => {
    const [mark, color] = GLYPH[d.status] ?? ['○']
    return <Text wrap="truncate-end">{IN(2)}<Text color={color}>{mark}</Text> <Text dimColor={d.status === 'completed'}>{d.text}</Text></Text>
  })
  let underHeading = false
  const plan = t.plan?.length ? [
    <Text dimColor wrap="truncate-end">{IN(2)}Plan · {plural(steps, 'step')}</Text>,
    ...(isNow ? t.plan.map(s => {
      if (s.mark === '#') {
        underHeading = true
        return <Text bold dimColor wrap="truncate-end">{IN(4)}{s.text}</Text>
      }
      return <Text wrap="truncate-end">{IN(4 + 2 * (s.depth + (underHeading ? 1 : 0)))}<Text dimColor>{s.mark}</Text> {s.text}</Text>
    }) : []),
  ] : []
  const mine = o.log.filter(a => a.thread === t.id)
  const when = (at?: number) => (at === undefined ? '' : ` · ${sentLabel(at).slice(5)}`)
  // The first prompt names the thread; each later one gets its own row.
  const prompts = mine.filter(a => a.kind === 'prompt').slice(1).slice(-3).map(a => (
    <Text wrap="truncate-end">{IN(2)}<Text dimColor>› </Text>{promptLine(a.text)}<Text dimColor>{when(a.at)}</Text></Text>
  ))
  const work = tasks.length ? [] : mine.filter(a => WORK[a.kind]).slice(-3).map(a => {
    const bad = a.kind === 'test' && a.text.startsWith('tests fail')
    const [mark, color] = bad ? ['✗', 'error'] : WORK[a.kind]!
    const text = a.kind === 'test' ? a.text.replace(/^tests (pass|fail): /, '') : a.text.replace(/^(commit|helper): /, '')
    return <Text wrap="truncate-end">{IN(2)}<Text color={color} dimColor={!color}>{mark}</Text> <Text dimColor>{text}{when(a.at)}</Text></Text>
  })
  return [
    lead,
    ...prompts,
    ...(run ? [<Text wrap="truncate-end">{IN(2)}<Text dimColor>❯ </Text><Text color="suggestion">{run.activeForm ?? run.text}…</Text></Text>] : []),
    ...tasks,
    ...work,
    ...plan,
  ]
}

/** Every thread newest first (the current one on top), each its head row then its own rows; `head[i]` is row i's thread head. */
function timeline(els: Els, o: Observed): { rows: JSX.Element[]; head: number[] } {
  const threads = ordered(o)
  const metas = threads.map(t => metaOf(o, t))
  // Each column as wide as its longest cell, so the columns line up down the list; a column empty everywhere drops.
  const widths = [0, 1, 2, 3].map(i => Math.max(0, ...metas.map(m => lenOf(m[i]!))))
  const rows: JSX.Element[] = []
  const head: number[] = []
  for (const t of threads) {
    const at = rows.length
    for (const r of threadBlock(els, o, t, widths)) { rows.push(r); head.push(at) }
  }
  return { rows, head }
}

/** How far ▲ ▼ can move a window of n rows: at the last offset the last row is in view. */
const roomOf = (len: number, n: number) => Math.max(0, len - n)

/** The timeline from row `off`, the head of the thread that row is in pinned over it like a navbar. */
function threadWindow(els: Els, o: Observed, off: number): JSX.Element[] {
  const { rows, head } = timeline(els, o)
  if (!rows.length) return [<els.Text dimColor>Nothing yet.</els.Text>]
  // Row `off` is the window's top; its thread's head takes that row, so each ▼ moves the rows under it by one.
  return [rows[head[off] ?? 0]!, ...rows.slice(off + 1)]
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
