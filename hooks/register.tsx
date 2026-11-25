import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, SessionMessage, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ArtifactRow, Artifacts, Band, Observed, Summary, SummaryCache, Tab, Thread, Todo } from '../types'
import {
  demoArtifacts, demoObserved, demoSummary, emptyObserved, hash, isTestCommand, onAgent, onArtifact, onCommit, onEdit,
  dropEngineText, isEngineText, clearErrors, isQuietExit, noticeOf, promptLine, untag, onNotice, onError, onPlan, onPrompt, onTest, onTodos, onTurnEnd, parseSummary, sentLabel, short, stamp, timeOf, transcriptTimes, type Times, unlist, testResult, SUMMARY_SYSTEM, summaryInput,
  summaryPrompt, SUMMARY_OUT, NAME_SYSTEM, threadName, SUM_SYSTEM, SUM_MIN, promptSum, setSum,
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
export const COMPACT_ROWS = 6
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
  const [now, isDemo, o, cache, arts, tab] = await Promise.all([r.now(), r.demo(), r.observed(), r.summary(), r.artifacts(), r.tab()])
  return {
    now,
    o: isDemo ? demoObserved(now) : o,
    cache: isDemo ? { key: 'demo', summary: demoSummary } : cache,
    arts: isDemo ? demoArtifacts(now) : arts.rows,
    tab,
  }
}

// shortcut: the last drawn timeline's scroll room, for the wheel hook; one band per process, keep per session if that changes.
let roomNow = 0

export const register: Register = (on, options) => {
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
      const times = transcriptTimes(await transcriptTail($, e.cwd).catch(() => ''))
      await update($, observed, o => {
        const said = o.log.filter(a => a.kind === 'prompt')
        // Rebuild when the transcript has prompts we never saw, or times for prompts rebuilt before without them.
        if (promptsIn(msgs) <= said.length && !(times.prompts.length && said.some(a => a.at === undefined))) return o
        const r = replay(msgs, times)
        // Keep the on-device names and send times of threads we already knew,
        // and the summaries of prompts we already knew, so the model never writes one twice.
        const sum = (a: Observed['log'][number]) => o.log.find(x => x.kind === 'prompt' && x.text === a.text)?.gist
        return {
          ...r,
          threads: r.threads.map(t => ({ ...o.threads.find(x => x.title === t.title), ...t })),
          log: r.log.map(a => (a.kind === 'prompt' && sum(a) ? { ...a, gist: sum(a) } : a)),
        }
      }).catch(() => {})
    }
    // Rebuilt or older long prompts get their one-line summary in the background, newest first.
    summarize($, (await read($, observed)).log.filter(a => a.kind === 'prompt' && !a.gist).slice(-LOAD_SUMS).reverse())
    // The view (size, 🤖/👤, tab) outlives the session: one for all, or one per project folder that starts from the global one.
    viewKey = options.rememberView === 'per project' ? `view:${e.cwd}` : 'view'
    const v = ((await $.store.get(viewKey).catch(() => undefined)) ?? (await $.store.get('view').catch(() => undefined))) as View | undefined
    if (v && ['collapsed', 'compact', 'expanded', 'min'].includes(v.mode)) await update($, band, (x): Band => ({ ...x, mode: v.mode, raw: !!v.raw }))
    if (v && TABS.some(([id]) => id === v.tab)) await update($, tabAtom, () => v.tab)
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
    await saveView($)
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
        void ask($, NAME_SYSTEM, e.text)
          .then(r => threadName(r))
          .then(name => name === undefined ? undefined : update($, observed, x => ({ ...x, threads: x.threads.map(y => (y.id === t.id ? { ...y, name } : y)) })))
          .catch(() => {})
      }
      if (!notice) summarize($, [o.log.findLast(a => a.kind === 'prompt')!])
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
    // The mods below, our state and the band read at once: one after another made every click redraw late.
    const [below, seen, b] = await Promise.all([
      next(e).catch(() => undefined),
      load({
        demo: () => read($, demo), observed: () => read($, observed), summary: () => read($, summary),
        artifacts: () => read($, artifacts), tab: () => read($, tabAtom), now: () => $.clock.now(),
      }),
      read($, band),
    ])
    // 👤: every prompt and thread row shows the prompt as typed; the gists stay stored for 🤖.
    const d = b.raw ? { ...seen, o: { ...seen.o, log: seen.o.log.map(a => ({ ...a, gist: undefined })), threads: seen.o.threads.map(t => ({ ...t, gist: undefined })) } } : seen
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
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
    const setView = (v: Partial<Band>) => update($, band, (x): Band => ({ ...x, ...v })).then(() => saveView($))
    const setMode = (mode: Band['mode']) => setView({ mode, all: false, scroll: 0 })
    const open = async (t: Tab) => {
      await update($, tabAtom, () => t)
      // A tab keeps a Compact band compact; from the one row it opens to Regular.
      await setView({ mode: b.mode === 'compact' ? 'compact' : 'expanded', all: false, scroll: 0 })
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
    // The timeline window: oldest at the top, newest at the bottom; it opens on the newest (back 0).
    const shown = b.mode === 'compact' ? mRows : cap
    const room = !isOpen || tab !== 'threads' || b.all ? 0 : roomOf(timeline(els, o, cols).rows.length, shown)
    roomNow = room
    const back = Math.min(b.scroll ?? 0, room)
    const off = room - back
    // One click moves a page, less one row, so the row at the edge stays in view.
    const page = Math.max(1, shown - 1)
    const scrollTo = (n: number) => update($, band, (x): Band => ({ ...x, scroll: Math.max(0, Math.min(room, n)) }))
    // 3 columns wide like the sizes; an arrow that cannot move stays in place, dim, so nothing shifts.
    const arrow = (key: string, glyph: string, can: boolean, to: number) =>
      can ? <Button key={key} plain label={` ${glyph} `} onPress={() => scrollTo(to)} /> : <Text dimColor>{` ${glyph} `}</Text>
    const [g, tone] = now ? headGlyph(o, now) : ['●', 'suggestion']
    // The latest prompt as typed, cleaned; the thread's name only when the prompt was all tags, links or paths.
    const said = now && (promptLine(now.prompt ?? '') || nameOf(now))
    const status = (
      <Text wrap="truncate-end">
        <Text color={tone}>{g}</Text> Now ({over}/{o.threads.length}): <Text bold>{said || 'waiting for the first prompt'}</Text>
      </Text>
    )
    // Groups split by a faint ┊; no gap between buttons, each padded 1 space a side, so the status keeps the room.
    const div = <Text color={FAINT}>┊</Text>
    const lit = (isOn: boolean, label: string) => (isOn ? <Text bold color="suggestion">{label}</Text> : label)
    const face = b.raw ? '👤' : '🤖'
    const buttons = (
      <Box flexDirection="row" flexShrink={0}>
        {!isNarrow && <Text dimColor>│</Text>}
        {/* No hotkey labels: keys go to the prompt, the band takes clicks. */}
        {TABS.map(([id, label]) => (
          // Dim tabs read as disabled: every tab is full text, the open one bold in the accent color.
          <Button key={`tab-${id}`} label={` ${label} `} plain onPress={() => open(id)}>{lit(isOpen && tab === id, ` ${label} `)}</Button>
        ))}
        {isOpen && tab === 'summary' && <Button key="refresh" plain label=" ↻ " onPress={() => showSummary(io, true)} />}
        {div}
        {SIZES.map(([mode, label]) => (
          <Button key={`size-${mode}`} label={` ${label} `} plain onPress={() => setMode(mode)}>{lit(b.mode === mode, ` ${label} `)}</Button>
        ))}
        {div}
        {/* 🤖 gists, 👤 the prompts as typed. The emoji is 2 columns wide: a 4-wide box holds " 🤖 " in any engine. */}
        <Box width={4} flexShrink={0}>
          <Button key="raw" plain label={` ${face} `} onPress={() => setView({ raw: !b.raw })} />
        </Box>
        {room > 0 && div}
        {room > 0 && arrow('top', '⤒', back < room, room)}
        {room > 0 && arrow('up', '▲', back < room, back + page)}
        {room > 0 && arrow('down', '▼', back > 0, back - page)}
        {room > 0 && arrow('bottom', '⤓', back > 0, 0)}
        {isOpen && b.all && <Button key="less" plain label=" Show less " onPress={() => showAll(false)} />}
        {/* Not "[-]": the engine draws its own [-] right after, which hides the band fully. */}
        <Button key="min" plain label=" ▾ " onPress={() => setMode('min')} />
      </Box>
    )
    const row = isNarrow ? (
      <Box flexDirection="column" width={width}>{status}{buttons}</Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={1} width={width}>
        {/* The title takes every column up to the │ before the tabs. */}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{status}</Box>
        {buttons}
      </Box>
    )
    if (!isOpen) return stack(row)

    // Push, not overlay: an absolute Box with a negative top is clipped to the band, so it cannot paint over the chat.
    const rule = <Text dimColor wrap="truncate-end">{'─'.repeat(cols)}</Text>
    const main = b.mode === 'compact' ? <Box flexDirection="column">{brief(els, d, act, cols, off, mRows)}</Box> : body(els, d, act, cap, cols, b.all ? 0 : off)
    return stack(<Box flexDirection="column" width={width}>{row}{rule}{main}</Box>)
  }).catch(($, e, next) => next(e))

  // The wheel over the band moves the timeline like ▲ ▼, a row a tick; the engine's own window stays put.
  on('ui.scroll', async ($, e, next) => {
    const b = await read($, band)
    if (e.component !== 'AbovePrompt' || !roomNow || b.all || !['compact', 'expanded'].includes(b.mode)) return next(e)
    await update($, band, (x): Band => ({ ...x, scroll: Math.max(0, Math.min(roomNow, (x.scroll ?? 0) - e.by)) }))
    return {}
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
  const r = cmd && isTestCommand(cmd) ? testResult(cmd, ran.text ?? '', !!ran.isError) : undefined
  // A failed run with no pass or fail count (a missing script, a bad path, a grep with no match) is a step
  // that failed, not a test result: it never blocks a task, and a later working step clears it.
  if (r && (r.isCounted || !ran.isError)) {
    o = onTest(o, r.ok, r.text)
  } else if (ran.isError && !isQuietExit(cmd, ran.text ?? '')) return onError(o, tool, ran.text ?? 'failed')
  else if (/\bgit\s+commit\b/.test(cmd)) o = onCommit(o, cmd)
  // This step worked (a grep with no match counts too): earlier errors no longer hold the thread.
  return ran.isError && !isQuietExit(cmd, ran.text ?? '') ? o : clearErrors(o)
}

/** Prompts the band rebuilds from the transcript at most: the newest ones. */
export const REPLAY_PROMPTS = 200
/** A person's prompt or a task report in the transcript; tool results and engine text are not. */
const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && !m.toolResults?.length && m.text.trim() !== '' && (!isEngineText(m.text) || !!noticeOf(m.text))
const promptsIn = (msgs: SessionMessage[]) => msgs.filter(m => isPrompt(m) && !noticeOf(m.text)).length

/**
 * The threads rebuilt from the session's transcript, for what happened before the mod loaded: each prompt,
 * then its tool calls, through the same steps as live. `times` (from the transcript file) gives each prompt its sent and res.
 */
export function replay(msgs: SessionMessage[], times: Times = { prompts: [], tools: {} }): Observed {
  const starts = msgs.flatMap((m, i) => (isPrompt(m) && !noticeOf(m.text) ? [i] : []))
  let o = emptyObserved
  let k = 0
  for (const m of msgs.slice(starts.at(-REPLAY_PROMPTS) ?? 0)) {
    if (m.role === 'assistant') {
      for (const u of m.toolUses) {
        o = observe(o, { ...u.input, tool: u.tool } as unknown as ToolCallInput, u as unknown as ToolCallResult)
        // The transcript file's stamp for its result gives the work row its time.
        const at = times.tools[u.tool_use_id]
        if (at !== undefined) o = stamp(o, at)
      }
    } else if (isPrompt(m)) {
      const notice = noticeOf(m.text)
      // A new prompt means the turn before it ended with an answer.
      o = notice ? onNotice(o, notice) : onPrompt(onTurnEnd(o, true), m.text)
      // The messages carry no times; the transcript file's stamps give the sent time.
      const i = notice ? -1 : timeOf(times.prompts, m.text, k)
      if (i >= 0) {
        k = i + 1
        o = stamp(o, times.prompts[i]!.at, true)
      }
    }
  }
  return o
}

/** What the band remembers across sessions, in `$.store` under `viewKey`. */
type View = { mode: Band['mode']; raw?: boolean; tab: Tab }
// Set at session.start from the "Remember view" setting: 'view' (global) or 'view:<cwd>' (per project).
let viewKey = 'view'
async function saveView($: EngineInterface): Promise<void> {
  const [b, tab] = await Promise.all([read($, band), read($, tabAtom)])
  await $.store.set(viewKey, { mode: b.mode, raw: !!b.raw, tab } satisfies View).catch(() => {})
}

/** One on-device model call (onDevice reads only HOME, the helper source and its binary). */
function ask($: EngineInterface, system: string, text: string): Promise<string | undefined> {
  const host = {
    plugin: { root: $.plugin.root },
    // The engine wants a literal name here; HOME is the only one onDevice reads.
    env: { get: () => $.env.get('HOME') },
    fs: { read: (p: string) => $.fs.read(p), exists: (p: string) => $.fs.exists(p) },
    process: { run: (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, opts) },
  } as unknown as Parameters<typeof onDevice>[0]
  return onDevice(host, system, untag(text).slice(0, 2000))
}

// One model run at a time, in the background: a summary never blocks a prompt or a redraw.
let sums: Promise<unknown> = Promise.resolve()
/** Asks the on-device model for a one-line summary of each long prompt that has none; a bad reply leaves the cut prompt. */
function summarize($: EngineInterface, prompts: Observed['log']): void {
  for (const p of prompts) {
    if (p.gist || [...promptLine(p.text)].length < SUM_MIN) continue
    sums = sums.then(() => ask($, SUM_SYSTEM, p.text))
      .then(r => promptSum(r, p.text))
      .then(sum => (sum ? update($, observed, o => setSum(o, p.text, sum)) : undefined))
      .catch(() => {})
  }
}
/** Prompts summarized at load, newest first: the rows most likely in view. */
const LOAD_SUMS = 20

/** The tail of this session's transcript file (the last 4 MB, the read limit), or '' when it cannot be read. */
async function transcriptTail($: EngineInterface, cwd: string): Promise<string> {
  // shortcut: assumes ~/.claude (no CLAUDE_CONFIG_DIR); read it if the band shows no times there.
  const file = `${await $.env.get('HOME')}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${await $.session.id()}.jsonl`
  const r = await $.process.run(['tail', '-c', '4000000', file], { timeoutMs: 5000 })
  return r.exitCode === 0 ? r.stdout : ''
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
  // One timeline at the full width; ▲ ▼ and the wheel move it under the pinned head, so nothing is cut.
  return <Box flexDirection="column">{threadWindow(els, d.o, off, cols).slice(0, cap)}</Box>
}

/**
 * The Compact body: the shown tab's most useful n lines. Threads: the timeline window under its pinned head.
 * Summary: the same board as L in n rows, as many items as fit. Artifacts: the newest one.
 */
function brief(els: Els, d: Data, act: Acts, cols: number, off: number, n: number): JSX.Element[] {
  const { Text } = els
  if (d.tab === 'artifacts') return artifactRows(els, d.arts, d.now, act, cols).slice(0, n)
  if (d.tab === 'threads') return threadWindow(els, d.o, off, cols).slice(0, n)
  return [summaryView(els, d.cache, n, act, cols, d.now)]
}

/** Whole items (each one or more lines) in at most n rows; the last row says how many items were cut. */
function fitItems(els: Els, items: JSX.Element[][], n: number, act: Acts, key: string): JSX.Element[] {
  if (items.flat().length <= n) return items.flat()
  const out: JSX.Element[] = []
  let k = 0
  while (k < items.length && out.length + items[k]!.length <= n - 1) out.push(...items[k++]!)
  return [...out, <els.Button key={`more-${key}`} plain dimColor label={`+${items.length - k} more`} onPress={act.all} />]
}

/** At most n rows; the last one says how many were cut, and a press shows them all. */
function fit({ Text, Button }: Els, lines: JSX.Element[], n: number, act: Acts, key: string): JSX.Element[] {
  if (lines.length <= n) return lines
  return [...lines.slice(0, Math.max(0, n - 1)), <Button key={`more-${key}`} plain dimColor label={`+${lines.length - n + 1} more`} onPress={act.all} />]
}

// ---- Threads tab: one timeline, each thread with its tasks and plan steps ----

/**
 * A thread's shown name: the on-device model's one-line summary of its first prompt, else that prompt cleaned of
 * tags, links and paths. When that leaves nothing, the model's name (checked again), else the title.
 */
const nameOf = (t: Thread) => t.gist || promptLine(t.first ?? '') || ((t.name ? threadName(t.name) : undefined) ?? unlist(untag(t.title)))
/** One glyph per thread state, the same in S, M and L: ▸ now, ✓ done, ✗ stuck, ⏸ paused. */
const headGlyph = (o: Observed, t: Thread): [string, string?] =>
  t.id === o.current ? ['▸', 'suggestion'] : isOver(t) ? ['✓', 'success']
    : t.todos.some(d => d.status === 'blocked') ? ['✗', 'error'] : t.state === 'paused' ? ['⏸'] : ['▸']
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`
const rank = (o: Observed, t: Thread) => (t.id === o.current ? 0 : isOver(t) ? 2 : 1)
/** Like the chat: finished threads at the top, then open ones, the current one last; oldest first in each group. */
export const ordered = (o: Observed) => [...o.threads].sort((a, b) => rank(o, b) - rank(o, a))
const running = (t: Thread) => t.todos.find(d => d.status === 'in_progress')

/** A cell's text in parts, each with its color (none: dim). */
type Part = [string, string?]
const num = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
/**
 * A test run's counts: "18 ✓ Pass" (green) when all pass, "3 ✗ Fail" (red) when all fail, else "18✓ 1✗";
 * 1000+ reads "1.2k". Empty when no count was read.
 */
export function testCell(text = ''): Part[] {
  const m = text.match(/(\d+) pass, (\d+) fail/)
  if (!m) return []
  const [p, f] = [+m[1]!, +m[2]!]
  if (!f) return p ? [[`${num(p)} ✓ Pass`, 'success']] : []
  if (!p) return [[`${num(f)} ✗ Fail`, 'error']]
  return [[`${num(p)}✓`, 'success'], [` ${num(f)}✗`, 'error']]
}
const lenOf = (c: Part[]) => c.reduce((a, [s]) => a + [...s].length, 0)
/** The tests column's least width: "18 ✓ Pass"; a wider cell widens it. */
const TESTS_W = 9

/** Rows with a time sorted oldest first into the slots timed rows held; rows with no time keep their place. */
export function byTime<T extends { at?: number }>(xs: T[]): T[] {
  const timed = xs.filter(x => x.at !== undefined).sort((a, b) => a.at! - b.at!)
  return xs.map(x => (x.at === undefined ? x : timed.shift()!))
}
/** The time column's width: "23:59". */
const TIME_W = 5
const clock = (at: number) => sentLabel(at).slice(5)
/** The column separator: much fainter than dim, barely there on the dark background. */
const FAINT = '#3a3a3a'

/** A thread's work rows, by log kind: the mark and its color (none: dim). */
const WORK: Partial<Record<Observed['log'][number]['kind'], [string, string?]>> = {
  edit: ['✎'], test: ['✓', 'success'], commit: ['◆'], agent: ['↳'],
}

/** Text in at most 2 lines of `w` columns, broken at a word; the second line ends in "…" when more is left. */
export function twoLines(s: string, w: number): [string, string?] {
  const c = [...s]
  if (c.length <= w) return [s]
  const sp = c.slice(0, w + 1).lastIndexOf(' ')
  const cut = sp > w / 2 ? sp : w
  const rest = c.slice(cut).join('').trim()
  return [c.slice(0, cut).join('').trimEnd(), [...rest].length > w ? [...rest].slice(0, w - 1).join('') + '…' : rest]
}

/** Indents: a thread at 0, its tasks and Claude's line at 2, plan steps at 4, nested steps 2 deeper each. */
const IN = (n: number) => ' '.repeat(n)

/**
 * One timeline row: the text on the left, cut with "…" at the first ┊, then the tests and time columns, kept on
 * every row at fixed widths so no text runs under them and every ┊ lines up top to bottom.
 */
function row({ Box, Text }: Els, testsW: number, left: JSX.Element, tests: Part[] = [], at?: number): JSX.Element {
  const cell = (w: number, parts: Part[]) => (
    <Box width={w + 3} flexShrink={0}>
      <Text wrap="truncate-end"><Text color={FAINT}>{' ┊ '}</Text>{' '.repeat(Math.max(0, w - lenOf(parts)))}{parts.map(([s, c]) => <Text color={c} dimColor={!c}>{s}</Text>)}</Text>
    </Box>
  )
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1} minWidth={0}>{left}</Box>
      {cell(testsW, tests)}
      {cell(TIME_W, at === undefined ? [] : [[clock(at)]])}
    </Box>
  )
}

/**
 * One thread as rows, each its own line: the head (glyph, name; its last test run and sent time in the columns),
 * the plan (folded to "Plan · N steps" unless current), every task (or with no tasks, the last 3 things done:
 * edits, test runs, commits, helpers) and the later prompts (`› <prompt>`, the last 3), all sorted by time with prompts
 * mixed in, then `❯ <activeForm>…` of the running task. Only the newest prompt of the timeline takes 2 rows.
 */
function threadBlock(els: Els, o: Observed, t: Thread, testsW: number, cols: number): JSX.Element[] {
  const { Text } = els
  const R = (left: JSX.Element, tests?: Part[], at?: number) => row(els, testsW, left, tests, at)
  const isNow = t.id === o.current
  const steps = (t.plan ?? []).filter(s => s.mark !== '#' && s.depth === 0).length
  const [g, tone] = headGlyph(o, t)
  const mine = o.log.filter(a => a.thread === t.id)
  const lead = R(
    <Text wrap="truncate-end"><Text color={tone}>{g}</Text> <Text bold color={isNow ? 'suggestion' : undefined}>{nameOf(t)}</Text></Text>,
    testCell(mine.findLast(a => a.kind === 'test')?.text), t.sentAt,
  )
  const run = running(t)
  const tasks = t.todos.map(d => {
    const [mark, color] = GLYPH[d.status] ?? ['○']
    return R(<Text wrap="truncate-end">{IN(2)}<Text color={color}>{mark}</Text> <Text dimColor={d.status === 'completed'}>{d.text}</Text></Text>)
  })
  let underHeading = false
  const plan = t.plan?.length ? [
    R(<Text dimColor wrap="truncate-end">{IN(2)}Plan · {plural(steps, 'step')}</Text>),
    ...(isNow ? t.plan.map(s => {
      if (s.mark === '#') {
        underHeading = true
        return R(<Text bold dimColor wrap="truncate-end">{IN(4)}{s.text}</Text>)
      }
      return R(<Text wrap="truncate-end">{IN(4 + 2 * (s.depth + (underHeading ? 1 : 0)))}<Text dimColor>{s.mark}</Text> {s.text}</Text>)
    }) : []),
  ] : []
  // The left area: the band less both columns and the "  › " indent; the newest prompt wraps inside it.
  const w = cols - (testsW + 3) - (TIME_W + 3) - 4
  const newest = o.log.findLast(a => a.kind === 'prompt')
  // The first prompt names the thread. Only the newest prompt of the timeline gets 2 rows; each older one gets
  // one: the model's summary when it wrote one, else the prompt cut at the first ┊.
  const prompts = mine.filter(a => a.kind === 'prompt').slice(1).slice(-3).map(a => {
    const [one, two] = a === newest ? twoLines(promptLine(a.text), w) : [a.gist ?? promptLine(a.text)]
    return { at: a.at, rows: [
      R(<Text wrap="truncate-end">{IN(2)}<Text dimColor>› </Text>{one}</Text>, [], a.at),
      ...(two ? [R(<Text wrap="truncate-end">{IN(4)}{two}</Text>)] : []),
    ] }
  })
  const work = tasks.length ? [] : mine.filter(a => WORK[a.kind]).slice(-3).map(a => {
    const bad = a.kind === 'test' && a.text.startsWith('tests fail')
    const [mark, color] = bad ? ['✗', 'error'] : WORK[a.kind]!
    // A test run's counts go to the tests column, not the text.
    const text = a.kind === 'test' ? a.text.replace(/^tests (pass|fail): /, '').replace(/: \d+ pass, \d+ fail$/, '') : a.text.replace(/^(commit|helper): /, '')
    return { at: a.at, rows: [R(<Text wrap="truncate-end">{IN(2)}<Text color={color} dimColor={!color}>{mark}</Text> <Text dimColor>{text}</Text></Text>, a.kind === 'test' ? testCell(a.text) : [], a.at)] }
  })
  // Oldest to newest, like the chat: what is live (the latest prompt, the running task) is the lowest row.
  return [
    lead,
    ...plan,
    ...tasks,
    ...byTime([...work, ...prompts]).flatMap(x => x.rows),
    ...(run ? [R(<Text wrap="truncate-end">{IN(2)}<Text dimColor>❯ </Text><Text color="suggestion">{run.activeForm ?? run.text}…</Text></Text>)] : []),
  ]
}

/** Every thread oldest first (the current one last), each its head row then its own rows; `head[i]` is row i's thread head. */
function timeline(els: Els, o: Observed, cols: number): { rows: JSX.Element[]; head: number[] } {
  // The tests column as wide as its longest cell on any row, so it lines up down the list.
  const testsW = Math.max(TESTS_W, ...o.log.filter(a => a.kind === 'test').map(a => lenOf(testCell(a.text))))
  const rows: JSX.Element[] = []
  const head: number[] = []
  for (const t of ordered(o)) {
    const at = rows.length
    for (const r of threadBlock(els, o, t, testsW, cols)) { rows.push(r); head.push(at) }
  }
  return { rows, head }
}

/** How far ▲ ▼ can move a window of n rows: at the last offset the last row is in view. */
const roomOf = (len: number, n: number) => Math.max(0, len - n)

/** The timeline from row `off`, the head of the thread that row is in pinned over it like a navbar. */
function threadWindow(els: Els, o: Observed, off: number, cols: number): JSX.Element[] {
  const { rows, head } = timeline(els, o, cols)
  if (!rows.length) return [<els.Text dimColor>Nothing yet.</els.Text>]
  // Row `off` is the window's top; its thread's head takes that row, so each ▼ moves the rows under it by one.
  return [rows[head[off] ?? 0]!, ...rows.slice(off + 1)]
}

// ---- Summary tab: Haiku's estimate, marked as one ----

/** Summary board: a column needs about 30 characters; columns sit 3 apart. */
export const BOARD_MIN = 30
const BOARD_GAP = 3
const ORDER: [Summary['tasks'][number]['status'], string, string?][] = [
  ['completed', 'Done', 'success'], ['active', 'Active', 'suggestion'], ['blocked', 'Stuck', 'error'], ['remaining', 'Left'],
]

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
  // Board: 4 columns across when each gets BOARD_MIN, else 2 x 2, else 1; columns in a row share the width.
  const across = cols >= 4 * BOARD_MIN + 3 * BOARD_GAP ? 4 : cols >= 2 * BOARD_MIN + BOARD_GAP ? 2 : 1
  const w = Math.floor((cols - BOARD_GAP * (across - 1)) / across)
  // In a column a name and its plain line each wrap to 2 lines, then cut, so "fix committ…" reads whole; one
  // column has the full width, so a task and its plain line share one row.
  const two = (x: string) => twoLines(x, w - 2).filter((l): l is string => !!l)
  const linesOf = ([st, label, tone]: (typeof ORDER)[number], isTight = false) => {
    const tasks = s.tasks.filter(t => t.status === st)
    const mark = <Text color={GLYPH[st]?.[1]}>{GLYPH[st]?.[0]}</Text>
    // Items, each its lines: the label, then a task (name and plain line), then each blocker.
    return [
      [<Text bold color={tone}>{label} {tasks.length}</Text>],
      ...tasks.map(t => across === 1 || isTight
        ? [<Text wrap="truncate-end">{mark} {t.name}{across === 1 && <Text dimColor>  {t.eli5}</Text>}</Text>]
        : [
          ...two(t.name).map((l, i) => (i ? <Text>  {l}</Text> : <Text>{mark} {l}</Text>)),
          ...two(t.eli5).map(l => <Text dimColor>  {l}</Text>),
        ]),
      ...(st === 'blocked' ? s.blockers.map(x => across === 1 || isTight
        ? [<Text color="error" wrap="truncate-end">  why: {x}</Text>]
        : two(`why: ${x}`).map(l => <Text color="error">  {l}</Text>)) : []),
    ]
  }
  const board = (isTight: boolean) => Array.from({ length: Math.ceil(ORDER.length / across) }, (_, i) => ORDER.slice(i * across, (i + 1) * across).map(g => [g[0], linesOf(g, isTight)] as const))
  const needsOf = (b: ReturnType<typeof board>) => b.map(g => Math.max(...g.map(([, l]) => l.flat().length)))
  // Every row gets all it needs when the board fits under the head and the work-left row. Else (M) each task
  // takes one row, name only, and the rows share the room evenly: as many tasks as fit.
  const fits = needsOf(board(false)).reduce((a, b) => a + b, 0) <= cap - 2
  const groups = board(!fits)
  const needs = needsOf(groups)
  const even = Math.max(2, Math.floor((cap - 2) / groups.length))
  const rows = groups.map((group, i) => (
    <Box flexDirection="row" gap={BOARD_GAP}>
      {group.map(([st, lines]) => <Box flexDirection="column" width={w}>{fitItems(els, lines, fits ? needs[i]! : even, act, `board-${st}`)}</Box>)}
    </Box>
  ))
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
