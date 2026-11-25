import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_REPLY, demoObserved, planSteps, sentLabel, threadName, parseSummary, short, snippet, SUMMARY_SYSTEM, summaryInput, summaryPrompt, titleOf, testResult, isEngineText, dropEngineText, isTestCommand, noticeOf, onNotice, promptLine } from '../hooks/observe'
import { bodyCap, safeHref, testCell } from '../hooks/register'
import { resetOnDevice } from '../hooks/ondevice'

test('only clean https URLs become links', () => {
  expect(safeHref('https://claude.ai/code/artifact/9a3e')).toBe('https://claude.ai/code/artifact/9a3e')
  expect(safeHref('https://x.ai/a\x1b]8;;evil\x07')).toBeUndefined()
  expect(safeHref('file:///etc/passwd')).toBeUndefined()
  expect(safeHref('not a url')).toBeUndefined()
  expect(short('a\x1b]8;;x\x07b')).toBe('a]8;;xb')
})

const BAND = (rows = 50, columns = 160) => ({
  plugin: 'whatcha-doing',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 40, bodyColumns: columns - 5, scroll: { offset: 0, bodyRows: 39 }, view: {} },
  viewport: { columns, rows },
  surface: 'terminal',
}) as const

declare const console: { log(...a: unknown[]): void }
declare function setTimeout(f: (v?: unknown) => void, ms: number): unknown
const SUMMARY = JSON.stringify({ p: 50, t: [['Fix login', 'a', 'Making sign in work again.'], ['Write a test', 'r', '']], b: [] })
// What a person typing the command at a fullscreen terminal raises.
const RUN = { command: 'whatcha', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const whatcha = (args: string) => ({ ...RUN, args })
const HOUR = 3_600_000
const T0 = 1_000 * HOUR

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On, toolText = (_: Record<string, unknown>) => 'ok', toolResult = (_: Record<string, unknown>): unknown => ({}), store = {}, lateMs = 0) {
  let calls = 0
  let sent = ''
  let maxTokens = 0
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  on('command.register', () => ({ value: { command: 'whatcha' } }))
  on('env.get', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => ({ result: toolResult(e as Record<string, unknown>), text: toolText(e as Record<string, unknown>) }))
  on('model.complete', async (_, e) => {
    if (lateMs) await clock.sleep(lateMs) // Haiku answers late: the band shows its updating state meanwhile
    calls++
    sent = (e.system ?? '') + e.prompt
    maxTokens = e.maxTokens ?? 0
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })
  return { calls: () => calls, sent: () => sent, maxTokens: () => maxTokens, clock }
}

// The drawn tree as plain lines: one line per outer Text, a Button as [label].
type Node = string | { type?: string; children?: Node[]; props?: { label?: string } }
const words = (n: Node): string => (typeof n === 'string' ? n : (n.children ?? []).map(words).join(''))
const flat = (n: unknown): string => {
  const x = n as Node
  if (typeof x === 'string') return ''
  if (x.type === 'Button') return `[${x.props?.label ?? words(x)}]\n`
  return x.type === 'Text' ? words(x) + '\n' : (x.children ?? []).map(flat).join('')
}
type N = { children: N[] }
// Ours sits above the engine's own slot: [band, engine]; the band is [row, rule, body].
const bodyOf = (tree: unknown) => (tree as N).children[0]!.children[2]!
const lines = (n: unknown) => flat(n).split('\n').filter(Boolean)
// A table row as the terminal shows it: the fixed-width first box padded, then the cells.
type R = { type?: string; children?: R[]; props?: { width?: number } }
const cell = (n: unknown) => flat(n).replace(/\n/g, '')
const rowText = (r: R) => {
  const w = r.type === 'Box' ? r.children?.[0]?.props?.width : undefined
  return (w ? cell(r.children![0]).padEnd(w) + r.children!.slice(1).map(cell).join('') : cell(r)).trimEnd()
}
// The Threads tab body: one timeline at the full width, as the terminal shows it.
// The timeline as lines; a sub row (indented) shows only its text, its columns checked by the tests that need them.
const subText = (ls: string[]) => ls.map(l => (/^\s/.test(l) ? nameCol(l) : l))
const timeline = (tree: unknown, w = 150) => subText(screen(bodyOf(tree), w))
// A thread row's name, without the meta columns; the thread rows are the ones at column 0.
const nameCol = (l: string) => l.split(' ┊')[0]!.trimEnd()
const heads = (rows: string[]) => rows.filter(l => /^\S/.test(l)).map(nameCol)
// Where each ┊ sits on a row: the same on every thread row when the columns line up.
const bars = (l: string) => [...l].flatMap((c, i) => (c === '┊' ? [i] : [])).join()

// A small terminal layout of the drawn tree: Box rows and columns, widths, gaps, grow and shrink, truncate-end.
type El = { type?: string; props?: Record<string, any>; children?: (El | string)[] }
const kidsOf = (n: El) => (n.children ?? []).filter(c => c !== '' && c !== null && c !== undefined && typeof c !== 'boolean')
const textOf = (n: El | string): string =>
  typeof n === 'string' ? n : n.type === 'Button' && !kidsOf(n).length ? String(n.props?.label ?? '') : kidsOf(n).map(textOf).join('')
const natural = (n: El | string): number => {
  if (typeof n === 'string' || n.type !== 'Box') return [...textOf(n)].length
  if (n.props?.width) return n.props.width
  const cs = kidsOf(n)
  return n.props?.flexDirection === 'row' ? cs.reduce((a, c) => a + natural(c), 0) + (n.props?.gap ?? 0) * Math.max(0, cs.length - 1) : Math.max(0, ...cs.map(natural))
}
const prop = (c: El | string, k: string) => (typeof c === 'string' ? undefined : c.props?.[k])
// As the engine lays out: every child shrinks by default (flexShrink 1), in proportion to its natural width,
// unless flexShrink is 0; a Text wraps at words unless it says truncate.
function draw(n: El | string, w: number): string[] {
  if (typeof n === 'string' || n.type !== 'Box') {
    const s = [...textOf(n)]
    if (s.length <= w) return [s.join('')]
    if (String(prop(n, 'wrap') ?? 'wrap').startsWith('truncate') || (typeof n !== 'string' && n.type === 'Button')) return [s.slice(0, Math.max(0, w - 1)).join('') + '…']
    const out: string[] = []
    let line = ''
    for (const word of s.join('').split(' ')) {
      if (line && [...line].length + 1 + [...word].length > w) { out.push(line); line = word } else line = line ? `${line} ${word}` : word
    }
    return [...out, line]
  }
  const width = Math.min(n.props?.width ?? w, w)
  const cs = kidsOf(n)
  if (n.props?.flexDirection !== 'row') return cs.flatMap(c => draw(c, width))
  const gap = n.props?.gap ?? 0
  const ws = cs.map(c => natural(c))
  const free = width - ws.reduce((a, b) => a + b, 0) - gap * (cs.length - 1)
  if (free < 0) {
    const weight = (c: El | string, i: number) => (prop(c, 'flexShrink') ?? 1) * ws[i]!
    const total = cs.reduce((a, c, i) => a + weight(c, i), 0)
    const cut = cs.map((c, i) => (total ? Math.ceil((-free * weight(c, i)) / total) : 0))
    cs.forEach((c, i) => { ws[i] = Math.max(prop(c, 'minWidth') ?? 0, ws[i]! - cut[i]!) })
  }
  const grow = cs.reduce((a, c) => a + (prop(c, 'flexGrow') ?? 0), 0)
  cs.forEach((c, i) => { if (free > 0 && prop(c, 'flexGrow')) ws[i] = ws[i]! + Math.floor((free * prop(c, 'flexGrow')) / grow) })
  const cols = cs.map((c, i) => draw(c, ws[i]!))
  const tall = Math.max(1, ...cols.map(c => c.length))
  return Array.from({ length: tall }, (_, r) => cols.map((c, i) => (c[r] ?? '').padEnd(ws[i]!) + (i < cs.length - 1 ? ' '.repeat(gap) : '')).join('').trimEnd())
}
const screen = (tree: unknown, w: number) => draw(tree as El, w).map(l => l.trimEnd())

test('band: one status row; Threads shows each thread with its tasks and plan, one row each, and the running task beside', async ($, on) => {
  const m = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND(120, 155)) // 120 rows: a 22-row body (the most); "+N more" then shows all
  const row = flat(await ui.drawn())
  expect(row).toContain('Now (2/4): Show the tax on each cart line in src/cart/CartTable.ts')
  expect(row).not.toContain('threads done')
  expect(row).not.toContain('~29%') // the gauge lives in Summary; the status row gives its room to the thread name
  expect(row).toContain('│')
  expect(row).toContain('[Artifacts]')
  expect(row).not.toMatch(/\b[tsa]: |Enter|press /) // keys go to the prompt: no key labels
  await ui.press({ key: 'tab-threads' })
  await $.command.run(whatcha('all'))
  // One timeline at the full width, oldest first like the chat: every thread expanded, only the current one's plan unfolded.
  const body = timeline(await ui.drawn())
  expect(heads(body)).toEqual(['✓ Why is CI red?', '✓ Bump Node 20 to 22 in CI', '✗ Fix checkout tax rounding', '▸ Show tax on each cart line'])
  // Thread > task > plan step: every task and every step on its own row, one indent level each.
  expect(body.slice(0, 9)).toEqual([
    expect.stringMatching(/^✓ Why is CI red\? +┊ {11}┊ \d+:\d\d$/), // finished threads first; an empty tests cell with no run
    '  ↳ read the CI logs', // no tasks: its last work instead
    expect.stringMatching(/^✓ Bump Node 20 to 22 in CI +┊ {11}┊ \d+:\d\d$/),
    '  ✓ Use Node 22 in the CI workflow',
    expect.stringMatching(/^✗ Fix checkout tax rounding +┊  11✓   1✗ ┊ \d+:\d\d$/), // "11✓ 1✗": 3 digits kept for each
    '  ✓ Round tax per line to the cent',
    '  ● Fix the two failing tax tests',
    '  ✗ Update the receipt snapshot',
    '  ❯ Fixing the two failing tax tests…',
  ])
  expect(body.slice(9)).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line {20,}┊ {11}┊ \d+:\d\d$/),
    '  Plan · 4 steps',
    '    Steps',
    '      1. Add a Tax column to CartTable.ts',
    '        · read the rate from the line item',
    '      2. Format it with formatMoney, the same way Price is formatted',
    '      3. Add a cart table test',
    '    Verification',
    '      · npm test passes',
    '  ● Add a tax column to CartTable',
    '  ○ Format it with formatMoney',
    '  ○ Add a cart table test',
    '  › Keep the tax column narrow, right-aligned like Price', // a later prompt, tags and list mark gone; its time in the column
    '  ❯ Adding a tax column to CartTable…', // the live line is the lowest
  ])
  // tests | files | commits | sent: the same columns on every thread row, right-aligned.
  expect(new Set(body.filter(l => /^\S/.test(l)).map(bars)).size).toBe(1)
  expect(body.join('\n')).not.toMatch(/Now: |│|next {2}/) // no running-task column beside the list
  await ui.unmount()
  // 90 columns: still one column; the names give way to the meta columns.
  const narrow = await $.ui.mount(BAND(120, 90))
  const n85 = screen(await narrow.drawn(), 85)
  console.log(['', 'Threads tab, L, 85 columns:', ...n85].join('\n'))
  expect(n85.every(l => [...l].length <= 85)).toBe(true)
  expect(timeline(await narrow.drawn(), 85)).toContain('  ❯ Adding a tax column to CartTable…')
  await narrow.unmount()
  expect(m.calls()).toBe(0) // demo never calls the model
})

test('the running task never shares a row: its subject is a task row, its activeForm the line under the thread', async ($, on) => {
  let id = 0
  engine(on, undefined, e => (e.tool === 'TaskCreate' ? { task: { id: String(++id) } } : {}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build the marketplace', wait: false, origin: { kind: 'composer' } } as never)
  const mk = (subject: string, activeForm: string) => ({ tool: 'TaskCreate', subject, activeForm, description: 'Staging, archive safety, SHA-256, atomic install with rollback.' })
  await $.tool.call(mk('Checkpoint 2: MarketplaceManager', 'Building MarketplaceManager') as never)
  await $.tool.call(mk('Checkpoint 3: MarketplaceInstaller (verify, atomic install, rollback)', 'Building MarketplaceInstaller') as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)
  const ui = await $.ui.mount(BAND(120, 155))
  await ui.press({ key: 'tab-threads' })
  expect(timeline(await ui.drawn()).slice(1)).toEqual([
    '  ✓ Checkpoint 2: MarketplaceManager',
    '  ● Checkpoint 3: MarketplaceInstaller (verify, atomic install, rollback)',
    '  ❯ Building MarketplaceInstaller…', // live, so the lowest row
  ])
  await ui.unmount()
})

test('▾ hides the band to an icon, and pressing it brings the row back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND())
  expect(flat(await ui.drawn())).toContain('Now (2/4): Show the tax on each cart line in src/cart/CartTable.ts')
  await ui.press({ key: 'min' })
  expect(flat(await ui.drawn()).trim()).toBe('[▴ @whatcha-doing]')
  await ui.press({ key: 'restore' })
  expect(flat(await ui.drawn())).toContain('Now (2/4): Show the tax on each cart line in src/cart/CartTable.ts')
  await ui.unmount()
})

test('height: L takes 20% of the terminal rows, at most 22 and at least 3; the timeline scrolls, never "+N more"; Show all, Show less', async ($, on) => {
  expect([24, 50, 120, 1000, 10].map(bodyCap)).toEqual([4, 10, 22, 22, 3])
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  await $.command.run(whatcha('threads'))
  // 24 rows: 4 rows; 50 rows: 10; 120 rows: 22 allowed. The newest row is always the last one shown.
  for (const [rows, n] of [[24, 4], [50, 10], [120, 22]] as const) {
    const ui = await $.ui.mount(BAND(rows))
    const list = timeline(await ui.drawn())
    expect(list.length).toBe(n)
    expect(list.at(-1)).toBe('  ❯ Adding a tax column to CartTable…')
    expect(list.join('\n')).not.toContain('more')
    await ui.unmount()
  }
  const ui = await $.ui.mount(BAND(24))
  await $.command.run(whatcha('all'))
  expect(timeline(await ui.drawn()).join('\n')).not.toContain('more')
  expect(timeline(await ui.drawn())).toContain('  ✓ Round tax per line to the cent') // the cut rows are back
  expect(flat(await ui.drawn())).toContain('[Show less]')
  await ui.press({ key: 'less' })
  expect(timeline(await ui.drawn()).length).toBe(4) // back to normal
  await ui.unmount()
})

test('sizes: S is the one row, M the 5 most useful lines of the tab, L up to 20% of the rows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND(50, 155))
  const band = async () => (await ui.drawn() as unknown as N).children[0]!
  const rows = async () => ((await band()).children[2]!.children as unknown as R[]).map(rowText)
  expect(flat(await band())).toMatch(/\[ S \]\n\[ M \]\n\[ L \]\n\[▾\]/) // 3-wide click targets
  await ui.press({ key: 'size-compact' })
  // M, Threads: the top 5 rows of the timeline, the current thread first.
  const m = screen(await band(), 150)
  console.log(['', 'Threads tab, M, 150 columns:', ...m].join('\n'))
  // Real height: status row + hairline + 5 body rows, inside the engine's maxRows, so it never scrolls a row away.
  expect(m).toHaveLength(7)
  // Opens on the newest: the current thread's head pinned on top, its latest prompt and running line lowest.
  expect(subText(m.slice(2))).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line {20,}┊ +┊ \d+:\d\d$/),
    '  ○ Format it with formatMoney',
    '  ○ Add a cart table test',
    expect.stringMatching(/^  › Keep the tax column narrow/),
    '  ❯ Adding a tax column to CartTable…',
  ])
  // ⤒ ▲ go back to older rows, ▼ ⤓ toward the newest; at the newest ▼ ⤓ are dim text, not buttons.
  expect(flat(await band())).toMatch(/\[ ⤒ \]\n\[ ▲ \]\n ▼ \n ⤓ /)
  // A click moves a page (5 rows less 1); deep in a thread, that thread's head stays on the top row.
  for (let i = 0; i < 3; i++) await ui.press({ key: 'up' })
  const deep = subText(screen(await band(), 150).slice(2))
  expect(nameCol(deep[0]!)).toBe('✗ Fix checkout tax rounding')
  expect(deep.slice(1)).toEqual(['  ✗ Update the receipt snapshot', '  ❯ Fixing the two failing tax tests…', expect.stringMatching(/^▸ Show tax on each cart line /), '  Plan · 4 steps'])
  await ui.press({ key: 'top' })
  expect(heads(screen(await band(), 150).slice(2))).toEqual(['✓ Why is CI red?', '✓ Bump Node 20 to 22 in CI', '✗ Fix checkout tax rounding'])
  expect(flat(await band())).toMatch(/ ⤒ \n ▲ \n\[ ▼ \]\n\[ ⤓ \]/)
  await ui.press({ key: 'bottom' })
  expect(screen(await band(), 150)).toEqual(m)
  await ui.press({ key: 'tab-summary' }) // a tab keeps the band compact
  expect(await rows()).toEqual([
    "~29% done ▰▰▰▱▱▱▱▱▱▱  Haiku's estimate",
    expect.stringMatching(/^● Active: .+  ✗ Stuck: /),
    expect.stringMatching(/^Work left: /),
  ])
  await ui.press({ key: 'tab-artifacts' })
  const arts = await rows()
  expect(arts).toHaveLength(5)
  expect(arts[0]).toMatch(/Artifacts  ·  click copies the link\s+Created  Modified$/)
  await ui.press({ key: 'size-expanded' })
  await ui.press({ key: 'tab-threads' })
  expect(timeline(await ui.drawn()).length).toBe(10)
  await ui.press({ key: 'size-collapsed' })
  expect(flat(await band())).not.toContain('───') // the status row alone: no rule, no body
  await $.command.run(whatcha('compact'))
  expect(await rows()).toHaveLength(5)
  await ui.unmount()
  // A 7-row slot under 120 columns: the header takes 2 rows, so M draws 4 and the band never scrolls a row away.
  const slot = { ...BAND(50, 105), props: { ...BAND(50, 105).props, maxRows: 7 } }
  const short = await $.ui.mount(slot)
  await short.press({ key: 'tab-threads' })
  expect(screen((await short.drawn() as unknown as N).children[0], 100)).toHaveLength(7)
  await short.unmount()
})

test('Summary board: 4 columns across, wrapping to 2 at 80 columns and 1 at 60, each row filling the width', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  await $.command.run(whatcha('summary'))
  // The board is [head, ...rows of columns, work left]; a row's columns carry their width.
  const board = async (columns: number) => {
    const ui = await $.ui.mount(BAND(50, columns))
    const kids = bodyOf(await ui.drawn()).children as unknown as { children: { props: { width: number } }[] }[]
    await ui.unmount()
    return kids.slice(1, -1).map(r => r.children.map(c => c.props.width))
  }
  expect(await board(160)).toEqual([[36, 36, 36, 36]]) // 155 body columns: (155 - 3 gaps of 3) / 4
  expect(await board(85)).toEqual([[38, 38], [38, 38]]) // 80: two across, each half
  expect(await board(65)).toEqual([[60], [60], [60], [60]]) // 60: one across, full width
})

test('Haiku runs only on the Summary tab, once per state', async ($, on) => {
  const m = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix login', status: 'in_progress', activeForm: 'Fixing login' }] })
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  await ui.press({ key: 'tab-artifacts' })
  expect(m.calls()).toBe(0)
  await ui.press({ key: 'tab-summary' })
  expect(m.calls()).toBe(1)
  expect(m.maxTokens()).toBe(250) // the owner's budget: 250 out
  const shown = flat(await ui.drawn())
  expect(shown).toContain('Making sign in work again')
  expect(shown).toContain('○ Write a test') // work left comes from the left tasks
  expect(shown).toContain("estimate: Haiku's guess")
  await ui.press({ key: 'tab-threads' })
  await ui.press({ key: 'tab-summary' })
  expect(m.calls()).toBe(1) // same state: the cache answers
  await ui.press({ key: 'refresh' })
  expect(m.calls()).toBe(2)
  await ui.unmount()
})

test('Summary updating: a thin bar fills under the last estimate while Haiku runs, then leaves', async ($, on) => {
  const m = engine(on, undefined, undefined, undefined, 8000)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix login', status: 'in_progress', activeForm: 'Fixing login' }] })
  const ui = await $.ui.mount(BAND())
  const first = ui.press({ key: 'tab-summary' })
  await m.clock.advance(3000)
  const bar = lines(bodyOf(await ui.drawn()))
  expect(bar).toHaveLength(1) // no estimate yet: the bar alone
  expect(bar[0]).toMatch(/^━+╸─+  updating with Haiku  3 s$/)
  await m.clock.advance(5000)
  await first
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix login', status: 'completed', activeForm: 'Fixing login' }] })
  const again = ui.press({ key: 'refresh' })
  await m.clock.advance(6000)
  const shown = lines(bodyOf(await ui.drawn()))
  expect(shown[0]).toBe("~50% done ▰▰▰▰▰▱▱▱▱▱  estimate: Haiku's guess from the task list, not measured")
  expect(shown[1]).toMatch(/updating with Haiku  6 s$/) // the bar sits under the head; the old board stays
  expect(shown.join('\n')).toContain('Making sign in work again')
  const full = (s: string) => s.split('━').length - 1
  expect(full(shown[1]!)).toBeGreaterThan(full(bar[0]!))
  await m.clock.advance(2000)
  await again
  expect(flat(await ui.drawn())).not.toContain('updating')
  await ui.unmount()
})

test('Haiku budget: the prompt stays at 600 tokens or fewer, even for a long session', () => {
  const tokens = (o: ReturnType<typeof demoObserved>) => (SUMMARY_SYSTEM + summaryPrompt(summaryInput(o))).length / 4
  const demo = demoObserved(T0)
  expect(tokens(demo)).toBeLessThanOrEqual(600)
  const t = demo.threads[0]!
  const long = { ...demo, threads: Array.from({ length: 40 }, (_, i) => ({ ...t, id: i + 1, title: `${t.title} again and again ${i}` })) }
  expect(tokens(long)).toBeLessThanOrEqual(600)
  // The frozen demo reply is Haiku's real answer and reads back whole.
  expect(parseSummary(DEMO_REPLY).tasks.length).toBe(7)
  expect(parseSummary('{"p":90,"t":[["Tax fix","d","done"]],"b":[""]}').blockers).toEqual([])
  expect(parseSummary('{"p":90,"t":[["Tax fix","d","done"]],"b":["CI is red"]}').blockers).toEqual([])
  expect(parseSummary('{"p":50,"t":[["Tax fix","b","stuck"]],"b":["None","CI is red"]}').blockers).toEqual(['CI is red'])
})

test('Artifacts: kept per project, newest change first, created and modified from the publishes', async ($, on) => {
  const old = { url: 'https://claude.ai/code/artifact/c', title: 'security audit', created: T0 - 48 * HOUR, modified: T0 - 48 * HOUR }
  const m = engine(on, () => 'ok', e => ({ url: `https://claude.ai/code/artifact/${e.file_path === '/p/b.html' ? 'b' : 'a'}`, title: e.title }), { 'artifacts:/p': [old] })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Artifact', file_path: '/p/a.html', title: 'band look' } as never)
  await m.clock.set(T0 + 1 * HOUR)
  await $.tool.call({ tool: 'Artifact', file_path: '/p/b.html', title: 'load test report' } as never)
  await m.clock.set(T0 + 2 * HOUR)
  await $.tool.call({ tool: 'Artifact', file_path: '/p/a.html', title: 'band look' } as never) // a republish
  await $.tool.call({ tool: 'Artifact', action: 'list' } as never) // not a publish
  await m.clock.set(T0 + 5 * HOUR)
  await $.command.run(whatcha('artifacts'))
  const ui = await $.ui.mount(BAND())
  const body = bodyOf(await ui.drawn())
  expect(lines(body)).toEqual([
    '  3 Artifacts  ·  click copies the link', '   Created  Modified',
    '● ', '[band look]', '    5h ago    3h ago', '╰╴🔗 https://claude.ai/code/artifact/a',
    '● ', '[load test report]', '    4h ago    4h ago', '╰╴🔗 https://claude.ai/code/artifact/b',
    '● ', '[security audit]', '    2d ago    2d ago', '╰╴🔗 https://claude.ai/code/artifact/c',
  ])
  // Every row is [name box of one width, times]: the Created and Modified columns sit at the same offset.
  type Row = { children: [{ props: { width: number } }, { children: string[] }] }
  const rows = body.children as unknown as Row[]
  expect(new Set(rows.map(r => r.children[0].props.width))).toEqual(new Set([135]))
  for (const r of rows) expect([0, 20]).toContain((r.children[1].children ?? []).join('').length)
  await ui.unmount()
})

test('prompt line: the owner\'s words, cut at a word near 80 chars', () => {
  expect(snippet('fix the   login\nbug')).toBe('fix the login bug')
  expect(snippet('wait, unrelated: why would the CI workflow fail on this repo? just look, short answer'))
    .toBe('wait, unrelated: why would the CI workflow fail on this repo? just look, short…')
  // A title keeps the whole first clause (the row cuts it at its width) and drops pasted-image tags.
  expect(isEngineText('<task-notification>\n<task-id>a1</task-id>')).toBe(true)
  expect(isEngineText('fix the <div> in header')).toBe(false)
  const fixed = dropEngineText({
    current: 1, threads: [{ id: 1, title: '<task-notification>', state: 'active', todos: [], files: [] }],
    log: [
      { kind: 'prompt', text: '<task-notification> <task-id>a1', thread: 1 },
      { kind: 'prompt', text: 'make the output better', thread: 1 },
      { kind: 'test', text: 'tests pass: sed -n 1,10p hooks/register.tsx', thread: 1 },
    ],
  })
  expect(fixed.threads[0]!.title).toBe('Make output better')
  expect(fixed.log.map(a => `${a.kind} ${a.text}`)).toEqual(['agent A background task finished', 'prompt make the output better'])
  // A task report reads as plain words in the current thread, not as a prompt or a thread of its own.
  const report = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Agent "Cover page" finished</summary>\n</task-notification>'
  expect(noticeOf(report)).toBe('Agent "Cover page" finished')
  expect(noticeOf('fix the tax')).toBeUndefined()
  const step = onNotice(fixed, noticeOf(report)!)
  expect([step.threads.length, step.log.at(-1)!.kind, step.log.at(-1)!.text]).toEqual([1, 'agent', 'Agent "Cover page" finished'])
  const runs = ['npm test', 'bun test', 'claude plugin test .', 'pytest -q', 'npx vitest run', 'jest', 'npm run test -- --watch']
  expect(runs.filter(isTestCommand)).toEqual(runs)
  // The shell's own test builtin and paths are not test runs.
  const not = ['sed -n 1p tests/tax.test.ts', 'M=/Users/me/MEMORY.md; test -f $M && tail -3 $M; echo done', 'test -d dist', 'if test -n "$X"; then echo y; fi', '[ -z "$X" ] && echo empty']
  expect(not.filter(isTestCommand)).toEqual([])
  expect(titleOf('[Image #1] here reduce padding, its not using the full width. thanks'))
    .toBe('Here reduce padding, its not using full width')
  // A prompt typed as a list item or quote: the title keeps the words, not the "- ".
  expect(['- Prompt reference: 4 Time sent', '1. fix the tax', '> why is CI red?', '* [ ] add a test'].map(titleOf))
    .toEqual(['Prompt reference', 'Fix tax', 'Why CI red', 'Add test'])
  // A chained command names only its test run, the last one.
  expect(testResult('sed -n 45p types/index.d.ts; tsc -p . && claude plugin validate . && claude plugin test . 2>&1 | tail -3', '18 pass\n0 fail', false).text)
    .toBe('claude plugin test .: 18 pass, 0 fail')
})

// A real session (5 prompts) replayed with its tool calls and results, taken from its transcript.
test('Replay: every prompt lands as a thread, tangent, nested step or return, and finished work reads as finished', async ($, on) => {
  const m = engine(on, e => (e.tool === 'Bash' && /npm test/.test(String(e.command)) ? TAP : 'ok'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const W = '/repo/'
  const turn = async (text: string, tools: Record<string, unknown>[]) => {
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
    for (const t of tools) await $.tool.call(t as never)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: text, reason: 'answer' } as never)
  }
  await turn('Add a dark mode option to src/settings.js: a theme pref, default light, that adds class dark to the section. Make a todo list first. Don\'t run tests yet.', [
    { tool: 'Bash', command: 'ls -R src && cat src/settings.js' },
    { tool: 'Edit', file_path: `${W}src/settings.js`, old_string: 'a', new_string: 'b' },
    { tool: 'Edit', file_path: `${W}src/settings.js`, old_string: 'c', new_string: 'd' },
  ])
  await turn('wait, unrelated: why would the CI workflow fail on this repo? just look, short answer', [
    { tool: 'Bash', command: 'ls -R .github && cat .github/workflows/* && cat package.json' },
  ])
  await turn('ok bump node in the CI workflow to 22', [{ tool: 'Edit', file_path: `${W}.github/workflows/ci.yml`, old_string: '16', new_string: '22' }])
  await turn('back to dark mode: run npm test and tell me what fails. Don\'t fix it yet.', [{ tool: 'Bash', command: 'npm test 2>&1 | head -60' }])
  await turn('new thing: write short release notes for 0.4.0 in CHANGELOG.md', [
    { tool: 'Bash', command: 'ls -a && cat CHANGELOG.md 2>&1 | head -20' },
    { tool: 'Write', file_path: `${W}CHANGELOG.md`, content: '# Changelog' },
  ])

  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  const list = timeline(await ui.drawn())
  // Finished threads oldest first, the current one last; each named by its first prompt, cues like "wait," gone.
  expect(heads(list)).toEqual([
    expect.stringMatching(/^✓ Add a dark mode option to src\/settings\.js: a theme pref/),
    '✓ Why would the CI workflow fail on this repo? just look, short answer',
    '✓ Bump node in the CI workflow to 22',
    '▸ Write short release notes for 0.4.0 in CHANGELOG.md',
  ])
  expect(list).toContainEqual(expect.stringMatching(/^✓ Add a dark mode option .*… ┊   2✓      ┊ \d+:\d\d$/))

  await ui.press({ key: 'tab-summary' })
  const sent = m.sent()
  // The compact digest: one line per thread with its side-trip parent and counts, then the last test.
  expect(sent).toContain('#1 Add dark mode option src/settings.js [done] 1 files\n#2<1 Why CI workflow fail repo [answered]\n')
  expect(sent).toContain('#3<2 Bump node CI workflow 22 [done] 1 files\n#4 Write short release notes 0.4.0 CHANGEL… [done] 1 files')
  expect(sent).toContain('now #4\ntest: pass npm test: 2 pass, 0 fail')
  await ui.unmount()
})

test('plan parsing: numbered and bulleted items with nesting and headings; wrapped lines join, prose and code drop', async ($, on) => {
  const md = [
    '# Fix checkout timeouts', '', '## Context', 'Customers see a timeout at Razorpay.', '',
    '## Steps', '1. Reproduce on the live site', '2. Confirm which store production uses',
    '3. Shopify admin and Razorpay checks:', '   - webhook URL', '   - API keys', '     1) live, not test',
    '4. Report findings to the', 'owner in one message', '', '```sh', '1. not a step', '```', '- [ ] **Checkpoint 3**: rollback',
  ].join('\n')
  expect(planSteps(md)).toEqual([
    { text: 'Steps', depth: 0, mark: '#' },
    { text: 'Reproduce on the live site', depth: 0, mark: '1.' },
    { text: 'Confirm which store production uses', depth: 0, mark: '2.' }, // two items, two steps: never glued
    { text: 'Shopify admin and Razorpay checks:', depth: 0, mark: '3.' },
    { text: 'webhook URL', depth: 1, mark: '·' },
    { text: 'API keys', depth: 1, mark: '·' },
    { text: 'live, not test', depth: 2, mark: '1.' },
    { text: 'Report findings to the owner in one message', depth: 0, mark: '4.' }, // a wrapped item stays one step
    { text: 'Checkpoint 3: rollback', depth: 0, mark: '·' },
  ])
  // ExitPlanMode's plan lands on the current thread.
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'customer has a checkout issue', wait: false, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'ExitPlanMode', plan: md } as never)
  const ui = await $.ui.mount(BAND(120, 155))
  await ui.press({ key: 'tab-threads' })
  const left = timeline(await ui.drawn())
  expect(left[0]).toMatch(/^▸ Customer has a checkout issue +┊ +┊ \d+:\d\d$/)
  expect(left!.slice(1, 5)).toEqual(['  Plan · 5 steps', '    Steps', '      1. Reproduce on the live site', '      2. Confirm which store production uses'])
  expect(left).toContain('          1. live, not test')
  await ui.unmount()
})

test('thread name: the owner\'s first prompt, cleaned; the on-device name only for a prompt of tags and paths', async ($, on) => {
  const ran: string[] = []
  let hasModel = true
  engine(on)
  on('fs.read', () => ({ value: 'swift source' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    ran.push(e.argv[0]!.split('/').pop()!)
    const isModel = e.argv[0]!.includes('ondevice-')
    const out = isModel && hasModel ? { exitCode: 0, stdout: '"Checkout timeout at Razorpay."\n' } : { exitCode: isModel ? 2 : 0, stdout: '' }
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...out } }
  })
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const status = async () => {
    const ui = await $.ui.mount(BAND())
    const s = flat(await ui.drawn())
    await ui.unmount()
    return s
  }
  resetOnDevice()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt('[Image #1] okay so um the customer says checkout goes to razorpay and then it just sits there and times out, can you look')
  await new Promise(r => setTimeout(r, 0))
  // The model's 4 words never stand in for what the owner typed: tags and "okay so um" go, the rest stays.
  const said = 'The customer says checkout goes to razorpay and then it just sits there and times out, can you look'
  expect(await status()).toContain(`Now (0/1): ${said}`)
  // The thread row ends with the local clock time the prompt was sent, from the prompt.submit stamp.
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  expect(timeline(await ui.drawn())[0]).toMatch(new RegExp(`^▸ ${said} +┊ +┊ \\d+:\\d\\d$`))
  expect([sentLabel(new Date(2026, 0, 1, 10, 42).getTime()), sentLabel(new Date(2026, 0, 1, 9, 5).getTime())]).toEqual(['sent 10:42', 'sent 9:05'])
  await ui.unmount()
  await prompt('look at the server logs too') // a step of the same thread: no second model run
  expect(ran.filter(c => c.startsWith('ondevice-')).length).toBe(1)
  expect(await status()).toContain('Now (0/1): Look at the server logs too') // the status row follows the latest prompt
  // A prompt of only tags and paths names nothing: the on-device name stands in.
  resetOnDevice()
  await prompt('new thing: [Image #2] /Users/me/Pictures/receipt.png')
  await new Promise(r => setTimeout(r, 0))
  expect(await status()).toContain('▸ Now (0/2): Checkout timeout at Razorpay')
  // No model (Apple Intelligence off): the prompt still names the thread.
  resetOnDevice()
  hasModel = false
  await prompt('new thing: fix the receipt snapshot test')
  await new Promise(r => setTimeout(r, 0))
  expect(await status()).toContain('▸ Now (0/3): Fix the receipt snapshot test') // the status row uses the thread glyph
  const l = await $.ui.mount(BAND(120))
  await l.press({ key: 'tab-threads' })
  expect(heads(timeline(await l.drawn()))).toEqual([`⏸ ${said}`, '⏸ Checkout timeout at Razorpay', '▸ Fix the receipt snapshot test'])
  await l.unmount()
  expect([threadName('Name: "Fix the tax"'), threadName(''), threadName('one two three four five six seven eight')]).toEqual(['Fix the tax', undefined, undefined]) // 8 words: never cut to 6, a cut echo is a fragment
})

const TAP = '> node --test\n\nTAP version 13\nok 1 - renders font size\nok 2 - snapshot\n1..2\n# tests 2\n# pass 2\n# fail 0\n'

test('a new topic opens a new thread, and a fragment like "Where are these" is never a name', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await prompt('where are these?')
  await prompt('can you create a graph rule which keeps a index of referances so it is easier to update referances global -> projects, and folders and stuff where context/rule/skill/insturctions live basically.')
  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  expect(heads(timeline(await ui.drawn()))).toEqual(['⏸ Where are these?', expect.stringMatching(/^▸ Can you create a graph rule which keeps a index of referances /)])
  await ui.unmount()
  // A fragment clause gives way to the next one; the on-device model's fragment is not a name.
  expect([titleOf('where are these? the rule files I mean'), threadName('Where are these'), threadName('Graph rule for references')])
    .toEqual(['Rule files I mean', undefined, 'Graph rule for references'])
})

test('live: a later prompt gets its own row at once, and a thread with no tasks shows its last work', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await prompt('[Image #1] here reduce padding, its too much on the icon tiles')
  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  await ui.press({ key: 'size-compact' })
  // Picks pasted from an options page: same thread, its own row right away, before Claude does anything.
  await prompt('- Exact: 1 Yellow on blue tile\n- Colors: 1 Yellow with dark outline\n- Morphed: No pick')
  expect(timeline(await ui.drawn())).toEqual([
    expect.stringMatching(/^▸ Here reduce padding, its too much on the icon tiles +┊ +┊ \d+:\d\d$/),
    expect.stringMatching(/^  › Exact: 1 Yellow on blue tile - Colors: .* Morphed: No pick$/),
  ])
  await $.tool.call({ tool: 'Bash', command: 'ls specs' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/spec/icons.md', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/Tile.tsx', old_string: 'a', new_string: 'b' } as never)
  const m = timeline(await ui.drawn())
  // The work, then the prompt it answers, lowest: the newest prompt stays the last row.
  expect(m.slice(1)).toEqual(['  ✎ spec/icons.md', '  ✎ src/Tile.tsx', expect.stringMatching(/^  › Exact: /)])
  expect(m.join('\n')).not.toContain('[Image')
  await ui.unmount()
  // An on-device reply cut to 6 words ends mid-clause: not a name.
  expect([threadName('[Image #1] here reduce padding, its'), threadName('here reduce padding on tiles')]).toEqual([undefined, 'Here reduce padding on tiles'])
})

test('long names: every ┊ stays in its column and every row is one line, at 150 and 100 columns', async ($, on) => {
  engine(on, e => (String(e.command ?? '').includes('test') ? '# pass 88\n# fail 12' : 'ok'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const work = async (commits: number, files: number) => {
    for (let i = 0; i < files; i++) await $.tool.call({ tool: 'Edit', file_path: `/w/src/f${i}.ts`, old_string: 'a', new_string: 'b' } as never)
    for (let i = 0; i < commits; i++) await $.tool.call({ tool: 'Bash', command: `git commit -m "c${i}"` } as never)
  }
  await prompt('[Image #1] /Users/me/Pictures/shot.png the settings window keeps its old size after I drag it bigger, and when I reopen it from the menu bar it jumps back to the small size again')
  await work(5, 3)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' } as never)
  await prompt('new thing: can you create a graph rule which keeps a index of referances so it is easier to update referances global -> projects, and folders and stuff where context lives')
  await work(12, 11)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await prompt('and make the index file update itself every time a rule file changes, and show me which projects point at each global rule so I can see what breaks before I edit it')
  for (const cols of [150, 100]) {
    const ui = await $.ui.mount(BAND(120, cols + 5))
    await ui.press({ key: 'tab-threads' })
    const body = bodyOf(await ui.drawn()) as unknown as N
    const list = screen(body, cols)
    if (cols === 150) console.log(['', 'Threads tab, L, 150 columns, long names:', ...screen(await ui.drawn(), 150)].join('\n'))
    expect(list).toHaveLength(body.children.length) // one line per row: no cell wrapped
    // Both columns sit on every row, thread rows and sub rows alike, so every ┊ is in the same place top to bottom.
    expect(new Set(list.map(bars)).size).toBe(1)
    expect(list.every(l => [...l].length <= cols)).toBe(true)
    const heads = list.filter(l => /^\S/.test(l))
    expect(heads).toHaveLength(2)
    expect(heads[0]).toMatch(/… ┊ +┊ \d+:\d\d$/)
    expect(heads[1]).toMatch(/… ┊  88✓  12✗ ┊ \d+:\d\d$/)
    // Sub rows put their time, and a test run its counts, in the columns, never in the text.
    expect(list).toContainEqual(expect.stringMatching(/^  ◆ c11 +┊ {11}┊ \d+:\d\d$/))
    expect(list).toContainEqual(expect.stringMatching(/^  ✗ npm test +┊  88✓  12✗ ┊ \d+:\d\d$/))
    // The 2-line prompt wraps inside the left area: its second row ends before the first ┊ too.
    const p = list.findIndex(l => l.startsWith('  › And make the index file'))
    expect(list[p]).toMatch(/ ┊ {11}┊ \d+:\d\d$/)
    expect(list[p + 1]).toMatch(/^    \S.* +┊ {11}┊$/)
    await ui.unmount()
  }
})

test('test counts: "18✓ 1✗", 3 digits kept for each, 1000 and up as "1.2k"; an empty cell with no count', () => {
  expect(testCell('npm test: 18 pass, 1 fail')).toEqual([[' 18✓', 'success'], ['   1✗', 'error']])
  expect(testCell('npm test: 7 pass, 0 fail')).toEqual([['  7✓', 'success'], ['     ']])
  expect(testCell('npm test: 1234 pass, 0 fail')[0]).toEqual(['1.2k✓', 'success'])
  expect(testCell('npm test')).toEqual([])
})

test('engine wrappers: pasted_content tags go, the text inside stays; the compaction summary is never a thread', async () => {
  expect(promptLine('<pasted_content id="384e"> - Overall: keep the dock small</pasted_content>')).toBe('Overall: keep the dock small')
  const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.'
  expect(isEngineText(summary)).toBe(true)
  // Saved before 1.0.20: a thread opened by the summary keeps its work but drops the summary as its name.
  const o = dropEngineText({
    current: 1, threads: [{ id: 1, title: titleOf(summary), first: summary, name: 'Claude file update delay', state: 'active', todos: [], files: [] }],
    log: [{ kind: 'prompt', text: summary, thread: 1 }, { kind: 'edit', text: 'src/a.ts', thread: 1 }],
  })
  expect(o.log.map(a => a.kind)).toEqual(['edit'])
  expect(o.threads[0]).toMatchObject({ title: 'Earlier work', first: undefined, name: undefined })
})
test('loaded mid-session, the band rebuilds the threads from the transcript', async ($, on) => {
  engine(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'fix the login redirect bug', toolUses: [] },
      {
        role: 'assistant', text: '', toolUses: [
          { tool_use_id: '1', tool: 'Edit', input: { file_path: '/w/src/login.ts' }, text: 'ok' },
          { tool_use_id: '2', tool: 'Bash', input: { command: 'git commit -m "Fix redirect"' }, text: 'ok' },
        ],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: '2', text: 'ok' }] },
      { role: 'user', text: 'new thing: write the release notes', toolUses: [] },
    ],
  }) as never)
  // The messages carry no times; the transcript file's lines do: the band reads its tail.
  const at = (h: number, m: number) => new Date(2026, 0, 1, h, m).toISOString()
  const jsonl = [
    '{"type":"user","timestamp":"cut line from the tail', // a tail starts mid-line
    JSON.stringify({ type: 'user', timestamp: at(9, 5), message: { content: 'fix the login redirect bug' } }),
    JSON.stringify({ type: 'assistant', timestamp: at(9, 7), message: { stop_reason: 'tool_use', content: [] } }),
    JSON.stringify({ type: 'user', timestamp: at(9, 8), message: { content: [{ type: 'tool_result', tool_use_id: '2', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(9, 12), message: { stop_reason: 'end_turn', content: [] } }),
    JSON.stringify({ type: 'user', timestamp: at(9, 20), message: { content: [{ type: 'text', text: 'new thing: write the release notes' }] } }),
  ].join('\n')
  const argv: (readonly string[])[] = []
  on('session.id', () => ({ value: 'abc' }))
  on('process.run', (_, e) => {
    argv.push(e.argv)
    return { value: { exitCode: 0, stdout: jsonl, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/w/my.app', surface: 'terminal', isInteractive: true })
  expect(argv[0]).toEqual(['tail', '-c', '4000000', 'undefined/.claude/projects/-w-my-app/abc.jsonl'])
  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  const list = timeline(await ui.drawn())
  expect(heads(list)).toEqual(['✓ Fix the login redirect bug', '▸ Write the release notes'])
  expect(list[0]).toMatch(/^✓ Fix the login redirect bug +┊ +┊  9:05$/)
  expect(list.find(l => l.startsWith('▸'))).toMatch(/^▸ Write the release notes +┊ +┊  9:20$/)
  // Each work row takes its tool result's time from the file: the commit came back at 9:08.
  expect(screen(bodyOf(await ui.drawn()), 150)).toContainEqual(expect.stringMatching(/^  ◆ Fix redirect +┊ {11}┊  9:08$/))
  await ui.unmount()
})
