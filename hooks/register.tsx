import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, SessionMessage, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Activity, ArtifactRow, Artifacts, Band, Observed, Summary, SummaryCache, Tab, Thread, Todo } from '../types'
import {
  demoArtifacts, demoObserved, demoSummary, sortSummary, touchTodos, emptyObserved, hash, isTestCommand, onAgent, onArtifact, onCommit, onEdit,
  dropEngineText, isEngineText, clearErrors, isQuietExit, noticeOf, promptLine, untag, onNotice, onError, onPlan, onPrompt, onTest, onTodos, onTurnEnd, parseSummary, sentLabel, short, stamp, timeOf, transcriptTimes, type Times, unlist, testResult, SUMMARY_SYSTEM, summaryInput,
  summaryPrompt, SUMMARY_OUT, NAME_SYSTEM, threadName, sumSystem, gistWords, BRIEF_SYSTEM, isPending, promptSum, setSum, key as promptKey,
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
      next = { key, summary: sortSummary(parseSummary(r.text), o) }
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
// shortcut: the `›` row's text width at the last draw (60 before one), for the gist's length; per session if bands multiply.
let gistRoom = 60

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
          log: r.log.map(a => (a.kind === 'prompt' && sum(a) !== undefined ? { ...a, gist: sum(a) } : a)),
        }
      }).catch(() => {})
    }
    // Rebuilt or older long prompts get their one-line summary in the background, newest first (the newest
    // with its S row brief); ones past the cap show as typed instead of waiting on "…" forever.
    // Ones the model never answered last time (`failed`) are asked again, inside the same cap.
    const owed = (await read($, observed)).log.filter(a => a.kind === 'prompt' && (isPending(a) || a.failed)).reverse()
    const late = new Set(owed.slice(LOAD_SUMS).filter(isPending).map(a => a.text))
    const again = new Set(owed.slice(0, LOAD_SUMS).filter(a => a.failed).map(a => a.text))
    if (late.size || again.size) {
      await update($, observed, o => ({
        ...o,
        log: o.log.map(a => (a.kind !== 'prompt' ? a : late.has(a.text) ? { ...a, gist: '' } : again.has(a.text) ? { ...a, gist: undefined, failed: undefined } : a)),
      })).catch(() => {})
    }
    summarize($, owed.slice(0, 1), true)
    summarize($, owed.slice(1, LOAD_SUMS))
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
          .then(r => threadName(r ?? undefined))
          .then(name => name === undefined ? undefined : update($, observed, x => ({ ...x, threads: x.threads.map(y => (y.id === t.id ? { ...y, name } : y)) })))
          .catch(() => {})
      }
      if (!notice) summarize($, [o.log.findLast(a => a.kind === 'prompt')!], true, e.text)
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
      await update($, observed, o => stamp(touchTodos(o, observe(o, e, ran), at), at))
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
    // '' (not undefined): a row with no gist shows the prompt, never the "…" of a gist on its way.
    const d = b.raw ? { ...seen, o: { ...seen.o, log: seen.o.log.map(a => ({ ...a, gist: '', brief: undefined })), threads: seen.o.threads.map(t => ({ ...t, gist: '' })) } } : seen
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
    // The `›` row's text: the band less the ↻, tests and time columns and the "  › " indent.
    gistRoom = Math.max(30, cols - (REDO_W + 3) - (TESTS_W + 3) - (TIME_W + 3) - 4)
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
    // The spinner moves only while the model owes some prompt its gist: the redraw stops by itself when none does.
    if (!spinner && seen.o.log.some(isBusy)) {
      spinner = $.clock.every(SPIN_MS, () => void read($, observed).then(o => {
        if (o.log.some(isBusy)) return $.ui.invalidate('ui.render')
        spinner?.cancel()
        spinner = undefined
      }).catch(() => {}))
    }
    const act: Acts = {
      spin: SPIN[Math.floor(seen.now / SPIN_MS) % SPIN.length]!,
      all: () => showAll(true),
      less: b.all ? () => showAll(false) : undefined,
      copy: (url, surface) => $.ui.copy({ text: url, surface }).then(r => r.isCopied && $.ui.toast(`Copied ${url}`)),
      redo: text => redo($, text),
      jump: async text => {
        // A press is the person's own input: the engine lets it scroll the transcript to that prompt's row.
        const requestId = drawnAt.get(promptKey(text))
        const r = requestId ? await $.ui.scroll({ to: { requestId }, block: 'start' }).catch(() => ({ deny: 'failed' })) : undefined
        if (!r || r.deny) await $.ui.toast('That prompt is not drawn in the chat yet')
      },
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
    const room = !isOpen || tab !== 'threads' || b.all ? 0 : roomOf(timeline(els, o, cols, act).rows.length, shown)
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
    // 🤖 the latest prompt's 3-6 word brief (else its gist), the spinner line while the model writes it; 👤 or no gist:
    // the prompt as typed, cleaned; the thread's name only when the prompt was all tags, links or paths.
    const last = now && o.log.findLast(a => a.kind === 'prompt' && a.thread === now.id)
    const wait = last && isBusy(last) ? busyText(last, act.spin) : undefined
    const said = now && ((last && (last.brief || last.gist)) || promptLine(now.prompt ?? '') || nameOf(now))
    const status = (
      <Text wrap="truncate-end">
        <Text color={tone}>{g}</Text> Now ({over}/{o.threads.length}): {wait ? <Text color={wait[1]}>{wait[0]}</Text> : <Text bold>{said || 'waiting for the first prompt'}</Text>}
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

  // Passive: each prompt row the chat draws, by its text, so a press on a band row can scroll the chat to it.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (drawnAt.size >= 500) drawnAt.delete(drawnAt.keys().next().value!)
    drawnAt.set(promptKey(e.props.text), e.requestId)
    return next(e)
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
      // A new prompt means the turn before it ended with an answer (its result line shows).
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
function ask($: EngineInterface, system: string, text: string): Promise<string | null | undefined> {
  const host = {
    plugin: { root: $.plugin.root },
    // The engine wants a literal name here; HOME is the only one onDevice reads.
    env: { get: () => $.env.get('HOME') },
    fs: { read: (p: string) => $.fs.read(p), exists: (p: string) => $.fs.exists(p) },
    process: { run: (argv: string[], opts?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, opts) },
  } as unknown as Parameters<typeof onDevice>[0]
  // 4000 chars is about 1000 tokens, well inside the model's 4096: a long dictated prompt is cut, never skipped (about 8 s).
  return onDevice(host, system, untag(text).slice(0, 4000))
}

// One model run at a time, in the background: a summary never blocks a prompt or a redraw.
// A just-sent prompt goes to the front, so it never waits behind the gists queued at load.
/** tries: retries done after no answer. context: earlier prompts (↻). was: the gist to keep if the redo gives none. */
type SumJob = { key: string; text: string; brief: boolean; tries?: number; context?: string; was?: string }
const jobs: SumJob[] = []
let summing = false
/** Prompts a ↻ press is summing again; a long prompt with no gist is owed one anyway. */
const redoing = new Set<string>()
/** Prompts waiting to be asked again after no answer: the retry number, 1 to 3. */
const retrying = new Map<string, number>()
/** The row shows the spinner: the model owes this prompt its gist ('' in 👤 view, so never there). */
const isBusy = (a: { kind?: string; text: string; gist?: string }) => (a.kind ?? 'prompt') === 'prompt' && a.gist === undefined && (isPending(a) || redoing.has(a.text))
/** Waits before asking again when the model gave no answer (helper error, or the 15 s timeout while other tabs use it). */
const RETRY_MS = [5_000, 20_000, 60_000]
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 120
// The redraw timer while some prompt is busy. shortcut: one per process, like roomNow; key it per session if that changes.
let spinner: { cancel(): void } | undefined
/** A busy prompt's line: "⠹ summarizing…" in Claude blue, "⠹ retrying, try 2 of 3" in the warning color. */
const busyText = (a: { text: string }, spin: string): Part => {
  const k = retrying.get(a.text)
  return k ? [`${spin} retrying, try ${k} of ${RETRY_MS.length}`, 'warning'] : [`${spin} summarizing…`, 'claude']
}
/** Every chat row the engine drew, by promptKey of its text: its requestId, for $.ui.scroll. */
// shortcut: one band per process, like roomNow; key it per session if that changes.
const drawnAt = new Map<string, string>()

function queue($: EngineInterface, add: SumJob[], first: boolean): void {
  if (first) jobs.unshift(...add)
  else jobs.push(...add)
  if (!summing) void drain($)
}
/**
 * Queues an on-device gist for each long prompt that has none. `now`: a just-sent prompt, first in line, which
 * also gets the S row's brief. `full`: the prompt as sent; the log keeps only its first 300 chars.
 */
function summarize($: EngineInterface, prompts: Observed['log'], now = false, full?: string): void {
  queue($, prompts.filter(isPending).map(p => ({ key: p.text, text: full ?? p.text, brief: now })), now)
}
async function drain($: EngineInterface): Promise<void> {
  summing = true
  try {
    for (let j = jobs.shift(); j; j = jobs.shift()) await gistOf($, j).catch(() => {})
  } finally {
    summing = false
  }
}
/**
 * One gist, asked once more in fewer words when the reply does not fit; '' when both do not, so the row shows the
 * prompt. No answer at all is not a bad reply: the prompt keeps its spinner and is asked again later.
 */
async function gistOf($: EngineInterface, j: SumJob): Promise<void> {
  if (!(await read($, observed)).log.some(a => a.kind === 'prompt' && a.text === j.key && isBusy(a))) return
  // One line: ask() folds every space and newline into one space.
  const text = j.context ? `Earlier prompts in this chat: ${j.context}. The request: ${j.text}` : j.text
  // undefined: no answer this time; '': an answer promptSum dropped, or a Mac whose model can never answer (null).
  // As many words as the `›` row holds at the band's last drawn width; a reply wider than the row is asked again shorter.
  const chars = gistRoom
  const sum = async (system: string, most?: number) => {
    const r = await ask($, j.context ? `${system} ${CONTEXT_NOTE}` : system, text)
    return r === undefined ? undefined : (promptSum(r ?? undefined, j.text, most, chars) ?? '')
  }
  let gist = await sum(sumSystem(chars), gistWords(chars) + 1)
  if (gist === '') gist = await sum(BRIEF_SYSTEM, 6)
  if (gist === undefined) return retry($, j)
  const brief = j.brief && gist ? (gist.split(' ').length <= 6 ? gist : (await sum(BRIEF_SYSTEM, 6)) || undefined) : undefined
  redoing.delete(j.key)
  retrying.delete(j.key)
  await update($, observed, o => setSum(o, j.key, gist || j.was || '', brief))
}
const CONTEXT_NOTE = 'The earlier prompts are context only: give the gist of the last request.'
/** No answer: back in the queue after 5, 20, then 60 s (others go first meanwhile); after that '' and `failed`. */
async function retry($: EngineInterface, j: SumJob): Promise<void> {
  const n = j.tries ?? 0
  if (n < RETRY_MS.length) {
    retrying.set(j.key, n + 1)
    return void $.clock.after(RETRY_MS[n]!, () => queue($, [{ ...j, tries: n + 1 }], false))
  }
  redoing.delete(j.key)
  retrying.delete(j.key)
  await update($, observed, o => setSum(o, j.key, j.was ?? '', undefined, !j.was))
}
/** ↻: the prompt's gist again, with the chat's 3 prompts before it as context; the spinner meanwhile. */
async function redo($: EngineInterface, text: string): Promise<void> {
  const o = await read($, observed)
  const i = o.log.findLastIndex(a => a.kind === 'prompt' && a.text === text)
  if (i < 0 || isBusy(o.log[i]!)) return
  const a = o.log[i]!
  const context = o.log.slice(0, i).filter(p => p.kind === 'prompt').slice(-3).map(p => `"${p.gist || promptLine(p.text).slice(0, 200)}"`).join('; ')
  redoing.add(text)
  await update($, observed, x => ({ ...x, log: x.log.map(p => (p.kind === 'prompt' && p.text === text ? { ...p, gist: undefined, failed: undefined } : p)) }))
  const isNewest = o.log.findLast(p => p.kind === 'prompt') === a
  queue($, [{ key: text, text, brief: isNewest, context: context || undefined, was: a.gist || undefined }], true)
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
type Acts = {
  all(): unknown; less?(): unknown; copy(url: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']): unknown
  /** ↻: sum up this prompt again, with context. */
  redo(text: string): unknown
  /** Scroll the chat to this prompt. */
  jump(text: string): unknown
  /** The spinner's frame for this draw. */
  spin: string
}
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
  return <Box flexDirection="column">{threadWindow(els, d.o, off, cols, act).slice(0, cap)}</Box>
}

/**
 * The Compact body: the shown tab's most useful n lines. Threads: the timeline window under its pinned head.
 * Summary: the same board as L in n rows, as many items as fit. Artifacts: the newest one.
 */
function brief(els: Els, d: Data, act: Acts, cols: number, off: number, n: number): JSX.Element[] {
  const { Text } = els
  if (d.tab === 'artifacts') return artifactRows(els, d.arts, d.now, act, cols).slice(0, n)
  if (d.tab === 'threads') return threadWindow(els, d.o, off, cols, act).slice(0, n)
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

/** The refresh column's width: " ↻ ". */
const REDO_W = 3
/** The time column's width: "23:59". */
const TIME_W = 5
const clock = (at: number) => sentLabel(at).slice(5)
/** The column separator: much fainter than dim, barely there on the dark background. */
const FAINT = '#3a3a3a'

/**
 * A turn's result line in words, never a command or a path: "18 tests passed" (green; a failed run red), then
 * "3 files changed", "1 commit", "1 helper started" (dim). Empty when the turn did none of these.
 */
export function resultLine(work: Activity[]): Part[] {
  const out: Part[] = []
  const test = work.findLast(a => a.kind === 'test')
  if (test) {
    const bad = test.text.startsWith('tests fail')
    const m = test.text.match(/(\d+) pass, (\d+) fail/)
    const n = m ? Number(bad ? m[2] : m[1]) : 0
    out.push([`${n ? plural(n, 'test') : 'tests'} ${bad ? 'failed' : 'passed'}`, bad ? 'error' : 'success'])
  }
  const files = new Set(work.filter(a => a.kind === 'edit').map(a => a.text)).size
  const commits = work.filter(a => a.kind === 'commit').length
  const helpers = work.filter(a => a.kind === 'agent' && a.text.startsWith('helper: ')).length
  if (files) out.push([`${plural(files, 'file')} changed`])
  if (commits) out.push([plural(commits, 'commit')])
  if (helpers) out.push([`${plural(helpers, 'helper')} started`])
  return out.flatMap((p, i) => (i ? [[' · '] as Part, p] : [p]))
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
 * One timeline row: the text on the left, cut with "…" at the first ┊, then the refresh, tests and time columns,
 * kept on every row at fixed widths so no text runs under them and every ┊ lines up top to bottom.
 */
function row({ Box, Text }: Els, testsW: number, left: JSX.Element, redo?: JSX.Element, tests: Part[] = [], at?: number): JSX.Element {
  const cell = (w: number, parts: Part[]) => (
    <Box width={w + 3} flexShrink={0}>
      <Text wrap="truncate-end"><Text color={FAINT}>{' ┊ '}</Text>{' '.repeat(Math.max(0, w - lenOf(parts)))}{parts.map(([s, c]) => <Text color={c} dimColor={!c}>{s}</Text>)}</Text>
    </Box>
  )
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1} minWidth={0}>{left}</Box>
      {redo ? <Box width={REDO_W + 3} flexShrink={0} flexDirection="row"><Text color={FAINT}>{' ┊ '}</Text>{redo}</Box> : cell(REDO_W, [])}
      {cell(testsW, tests)}
      {cell(TIME_W, at === undefined ? [] : [[clock(at)]])}
    </Box>
  )
}

/**
 * One thread as rows, each its own line: the head (glyph, name; ↻, its last test run and sent time in the columns),
 * the plan (folded to "Plan · N steps" unless current), every task, the later prompts (`› <prompt>`, the last 3) with
 * a dim `⎿ <result>` line under each turn Claude replied to, then `❯ <activeForm>…` of the running task. Prompts sent
 * before the reply stack, and their one result line covers the work since the first of them. Only the newest prompt
 * of the timeline takes 2 rows.
 */
function threadBlock(els: Els, o: Observed, t: Thread, testsW: number, cols: number, act: Acts): JSX.Element[] {
  const { Box, Text, Button } = els
  // ↻ on a prompt's row: sum it up again, with the chat's earlier prompts as context.
  const R = (left: JSX.Element, redo?: Activity, tests?: Part[], at?: number) =>
    row(els, testsW, left, redo && <Button key={`redo-${o.log.indexOf(redo)}`} plain dimColor label=" ↻ " onPress={() => act.redo(redo.text)} />, tests, at)
  const isNow = t.id === o.current
  const steps = (t.plan ?? []).filter(s => s.mark !== '#' && s.depth === 0).length
  const [g, tone] = headGlyph(o, t)
  const mine = o.log.filter(a => a.thread === t.id)
  // The left area: the band less the 3 columns. Button labels are cut to it here, so a row stays one line.
  const left = cols - (REDO_W + 3) - (testsW + 3) - (TIME_W + 3)
  const cut = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, Math.max(0, n - 1)).join('') + '…' : s)
  // A prompt's text is a plain Button: a press scrolls the chat to it; under the pointer it turns the accent color,
  // underlined. While the model sums it: the spinner line, then (in `n` columns) the prompt as typed, dim.
  const jump = (a: Activity, text: string, n: number, bold = false, color?: string) => {
    const i = o.log.indexOf(a)
    if (!isBusy(a)) {
      return (
        <Button key={`jump-${i}`} plain label={text} onPress={() => act.jump(a.text)}>
          <Text bold={bold} color={color} hover={{ scope: `jump-${i}`, color: 'suggestion', underline: true }}>{text}</Text>
        </Button>
      )
    }
    const [s, c] = busyText(a, act.spin)
    const room = n - [...s].length - 2
    return (
      <Button key={`jump-${i}`} plain label={s} onPress={() => act.jump(a.text)}>
        {[<Text color={c}>{s}</Text>, ...(room > 3 ? [<Text dimColor>{`  ${cut(promptLine(a.text), room)}`}</Text>] : [])]}
      </Button>
    )
  }
  const first = mine.find(a => a.kind === 'prompt' && (t.first === undefined || a.text === t.first))
  const name = cut(nameOf(t), left - 2)
  const lastTest = testCell(mine.findLast(a => a.kind === 'test')?.text)
  const lead = first
    ? R(<Box flexDirection="row"><Box flexShrink={0}><Text color={tone}>{g} </Text></Box>{jump(first, name, left - 2, true, isNow ? 'suggestion' : undefined)}</Box>, first, lastTest, t.sentAt)
    : R(<Text wrap="truncate-end"><Text color={tone}>{g}</Text> <Text bold color={isNow ? 'suggestion' : undefined}>{name}</Text></Text>, undefined, lastTest, t.sentAt)
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
  // The left area less the "  › " indent; the newest prompt wraps inside it.
  const w = left - 4
  const newest = o.log.findLast(a => a.kind === 'prompt')
  // Turns: the prompts sent before Claude's reply stack in one; its work is everything done after the first of them.
  type Turn = { prompts: Activity[]; work: Activity[]; isReplied: boolean }
  const turns: Turn[] = []
  for (const a of mine) {
    const now = turns.at(-1)
    if (a.kind === 'prompt') now && !now.isReplied ? now.prompts.push(a) : turns.push({ prompts: [a], work: [], isReplied: false })
    else if (a.kind === 'reply') { if (now) now.isReplied = true }
    else now?.work.push(a)
  }
  const head = turns[0]?.prompts[0]
  // The first prompt names the thread; the last 3 later ones get a row.
  const shown = new Set(turns.flatMap(x => x.prompts).slice(1).slice(-3))
  // Each prompt row shows the model's gist, else the prompt; the newest wraps to 2 rows (busy: the spinner, then the
  // prompt as typed, dim), each older one is cut at the first ┊.
  const promptRows = (a: Activity) => {
    const busy = isBusy(a)
    const text = a.gist || promptLine(a.text)
    const [one, two] = a !== newest ? [cut(text, w)] : busy ? ['', cut(promptLine(a.text), w)] : twoLines(text, w)
    return [
      R(<Box flexDirection="row"><Box flexShrink={0}><Text>{IN(2)}<Text dimColor>› </Text></Text></Box>{jump(a, one, a === newest ? 0 : w)}</Box>, a, [], a.at),
      ...(two ? [R(<Text dimColor={busy} wrap="truncate-end">{IN(4)}{two}</Text>)] : []),
    ]
  }
  // Under each turn Claude replied to, one dim result line; none while it works, or when the turn did nothing.
  const flow = turns.flatMap(x => {
    const said = x.isReplied && (x.prompts.at(-1) === head || shown.has(x.prompts.at(-1)!)) ? resultLine(x.work) : []
    return [
      ...x.prompts.filter(a => shown.has(a)).flatMap(promptRows),
      ...(said.length ? [R(<Text wrap="truncate-end">{IN(4)}<Text dimColor>⎿ </Text>{said.map(([s, c]) => <Text color={c} dimColor={!c}>{s}</Text>)}</Text>, undefined, [], x.work.findLast(a => a.at !== undefined)?.at)] : []),
    ]
  })
  // Oldest to newest, like the chat: what is live (the latest prompt, the running task) is the lowest row.
  return [
    lead,
    ...plan,
    ...tasks,
    ...flow,
    ...(run ? [R(<Text wrap="truncate-end">{IN(2)}<Text dimColor>❯ </Text><Text color="suggestion">{run.activeForm ?? run.text}…</Text></Text>)] : []),
  ]
}

/** Every thread oldest first (the current one last), each its head row then its own rows; `head[i]` is row i's thread head. */
function timeline(els: Els, o: Observed, cols: number, act: Acts): { rows: JSX.Element[]; head: number[] } {
  // The tests column as wide as its longest cell on any row, so it lines up down the list.
  const testsW = Math.max(TESTS_W, ...o.log.filter(a => a.kind === 'test').map(a => lenOf(testCell(a.text))))
  const rows: JSX.Element[] = []
  const head: number[] = []
  for (const t of ordered(o)) {
    const at = rows.length
    for (const r of threadBlock(els, o, t, testsW, cols, act)) { rows.push(r); head.push(at) }
  }
  return { rows, head }
}

/** How far ▲ ▼ can move a window of n rows: at the last offset the last row is in view. */
const roomOf = (len: number, n: number) => Math.max(0, len - n)

/** The timeline from row `off`, the head of the thread that row is in pinned over it like a navbar. */
function threadWindow(els: Els, o: Observed, off: number, cols: number, act: Acts): JSX.Element[] {
  const { rows, head } = timeline(els, o, cols, act)
  if (!rows.length) return [<els.Text dimColor>Nothing yet.</els.Text>]
  // Row `off` is the window's top; its thread's head takes that row, so each ▼ moves the rows under it by one.
  return [rows[head[off] ?? 0]!, ...rows.slice(off + 1)]
}

// ---- Summary tab: Haiku's estimate, marked as one ----

/** Summary board: a column needs about 30 characters; columns sit 3 apart. */
export const BOARD_MIN = 30
const BOARD_GAP = 3
// A normal kanban, left to right: to do, in progress, failed, done (2 x 2: Left, Active over Stuck, Done).
const ORDER: [Summary['tasks'][number]['status'], string, string?][] = [
  ['remaining', 'Left'], ['active', 'Active', 'suggestion'], ['blocked', 'Stuck', 'error'], ['completed', 'Done', 'success'],
]
/** The dim line under an empty Summary column (Stuck draws its own, with a green ✓). */
const EMPTY: Record<string, string> = { completed: 'nothing finished yet', active: 'nothing running', remaining: 'nothing left' }

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
      // An empty column says so in one dim line instead of blank space.
      ...(tasks.length ? [] : [[<Text dimColor wrap="truncate-end">{st === 'blocked' && <Text color="success">✓ </Text>}{st === 'blocked' ? 'nothing stuck' : EMPTY[st]}</Text>]]),
    ]
  }
  // One column: the empty groups share one line ("Stuck: nothing · Left: nothing") to save rows.
  const empty = across === 1 ? ORDER.filter(([st]) => !s.tasks.some(t => t.status === st)) : []
  const shown = ORDER.filter(g => !empty.includes(g))
  const shared = [<Text wrap="truncate-end">{empty.map(([, label, tone], i) => <Text>{i ? <Text dimColor>  ·  </Text> : ''}<Text bold color={tone}>{label}:</Text><Text dimColor> nothing</Text></Text>)}</Text>]
  const board = (isTight: boolean) => [
    ...Array.from({ length: Math.ceil(shown.length / across) }, (_, i) => shown.slice(i * across, (i + 1) * across).map(g => [g[0] as string, linesOf(g, isTight)] as const)),
    ...(empty.length ? [[['empty', [shared] as JSX.Element[][]] as const]] : []),
  ]
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
