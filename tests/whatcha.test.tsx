import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_REPLY, demoObserved, planSteps, sentLabel, threadName, parseSummary, short, snippet, SUMMARY_SYSTEM, summaryInput, summaryPrompt, titleOf, testResult, isEngineText, dropEngineText, isTestCommand, noticeOf, onNotice } from '../hooks/observe'
import { bodyCap, safeHref, wrap } from '../hooks/register'
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
// The Threads tab body is [threads, divider, running task]: returns [thread lines, task lines, divider lines].
const columns = (tree: unknown) => {
  const [left, divider, right] = bodyOf(tree).children as unknown as R[]
  return [screen(left, 200), screen(right, 200), lines(divider)]
}

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
function draw(n: El | string, w: number): string[] {
  if (typeof n === 'string' || n.type !== 'Box') {
    const s = [...textOf(n)]
    return [s.length > w ? s.slice(0, w - 1).join('') + '…' : s.join('')]
  }
  const width = Math.min(n.props?.width ?? w, w)
  const cs = kidsOf(n)
  if (n.props?.flexDirection !== 'row') return cs.flatMap(c => draw(c, width))
  const gap = n.props?.gap ?? 0
  const ws = cs.map(c => (prop(c, 'flexGrow') ? 0 : natural(c)))
  const free = width - ws.reduce((a, b) => a + b, 0) - gap * (cs.length - 1)
  const shrink = cs.findIndex(c => prop(c, 'flexShrink'))
  if (free < 0 && shrink >= 0) ws[shrink] = Math.max(1, ws[shrink]! + free)
  const grow = cs.filter(c => prop(c, 'flexGrow')).length
  cs.forEach((c, i) => { if (prop(c, 'flexGrow')) ws[i] = Math.floor(Math.max(0, free) / grow) })
  const cols = cs.map((c, i) => draw(c, ws[i]!))
  const tall = Math.max(1, ...cols.map(c => c.length))
  return Array.from({ length: tall }, (_, r) => cols.map((c, i) => (c[r] ?? '').padEnd(ws[i]!) + (i < cs.length - 1 ? ' '.repeat(gap) : '')).join('').trimEnd())
}
const screen = (tree: unknown, w: number) => draw(tree as El, w).map(l => l.trimEnd())

test('band: one status row; Threads shows each thread with its tasks and plan, one row each, and the running task beside', async ($, on) => {
  const m = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND(120, 155)) // 120 rows: a 22-row body (the most), so the list cuts
  const row = flat(await ui.drawn())
  expect(row).toContain('Now (2/4): Show tax on each cart line')
  expect(row).not.toContain('threads done')
  expect(row).toContain('~29%')
  expect(row).toContain('[Artifacts]')
  expect(row).not.toMatch(/\b[tsa]: |Enter|press /) // keys go to the prompt: no key labels
  await ui.press({ key: 'tab-threads' })
  const [left, right, divider] = columns(await ui.drawn())
  expect(left).toHaveLength(22)
  expect(left!.at(-1)).toMatch(/^\+\d+ more$/)
  expect(divider).toEqual(Array(22).fill('│')) // the divider spans every row
  await ui.press({ key: 'more-threads' })
  const all = screen(await ui.drawn(), 150)
  console.log(['', 'Threads tab, L, show all, 150 columns:', ...all].join('\n'))
  const body = columns(await ui.drawn())[0]!
  // Thread > task > plan step: every task and every step on its own row, one indent level each.
  expect(body.slice(0, 15)).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line  ·  now {2,}0 of 3 done  ·  sent \d+:\d\d$/),
    '  ❯ Adding a tax column to CartTable…',
    '    1 file',
    '  ● Add a tax column to CartTable',
    '  ○ Format it with formatMoney',
    '  ○ Add a cart table test',
    '  Plan · 4 steps',
    '    Steps',
    '      1. Add a Tax column to CartTable.ts',
    '        · read the rate from the line item',
    '      2. Format it with formatMoney, the same way Price is formatted',
    '      3. Add a cart table test',
    '    Verification',
    '      · npm test passes',
    '',
  ])
  expect(body).toContain('    11 tests pass  ·  1 fails  ·  3 files')
  expect(body.filter(l => l === '').length).toBe(3) // a blank row between the 4 threads
  expect(body.at(-1)).toMatch(/^✓ Why is CI red\?  ·  answered/) // finished threads last
  const [, task] = columns(await ui.drawn())
  expect(task![0]).toMatch(/^Now: Add a tax column to CartTable {2,}task 1 of 3$/)
  expect(task![1]).toBe('Adding a tax column to CartTable…')
  expect(task!.join(' ')).toContain('Read the rate from the line item, not the cart')
  expect(task!.at(-1)).toBe('next  Format it with formatMoney')
  await ui.unmount()
  // 85 columns: the running task goes under the threads.
  const narrow = await $.ui.mount(BAND(120, 90)) // show all is still on
  const n85 = screen(await narrow.drawn(), 85)
  console.log(['', 'Threads tab, L, show all, 85 columns:', ...n85].join('\n'))
  expect(n85.every(l => [...l].length <= 85)).toBe(true)
  expect(n85).toContain('Adding a tax column to CartTable…')
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
  const [left, right] = columns(await ui.drawn())
  expect(left!.slice(1)).toEqual([
    '  ❯ Building MarketplaceInstaller…',
    '  ✓ Checkpoint 2: MarketplaceManager',
    '  ● Checkpoint 3: MarketplaceInstaller (verify, atomic install, rollback)',
  ])
  expect(right!.slice(0, 3)).toEqual([expect.stringMatching(/^Now: Checkpoint 3: MarketplaceInstaller.* {2,}task 2 of 2$/), 'Building MarketplaceInstaller…', ''])
  expect(right!.slice(3).join(' ')).toBe('Staging, archive safety, SHA-256, atomic install with rollback.') // the description, wrapped
  await ui.unmount()
})

test('▾ hides the band to an icon, and pressing it brings the row back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND())
  expect(flat(await ui.drawn())).toContain('Now (2/4): Show tax on each cart line')
  await ui.press({ key: 'min' })
  expect(flat(await ui.drawn()).trim()).toBe('[▴ @whatcha-doing]')
  await ui.press({ key: 'restore' })
  expect(flat(await ui.drawn())).toContain('Now (2/4): Show tax on each cart line')
  await ui.unmount()
})

test('height: L takes 20% of the terminal rows, at most 22 and at least 3; "+N more" shows all, Show less goes back', async ($, on) => {
  expect([24, 50, 120, 1000, 10].map(bodyCap)).toEqual([4, 10, 22, 22, 3])
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  await $.command.run(whatcha('threads'))
  for (const [rows, cap] of [[24, 4], [50, 10], [120, 22]] as const) {
    const ui = await $.ui.mount(BAND(rows))
    const [left, , divider] = columns(await ui.drawn())
    expect([left!.length, divider!.length]).toEqual([cap, cap])
    expect(left!.at(-1)).toMatch(/^\+\d+ more$/)
    await ui.unmount()
  }
  const ui = await $.ui.mount(BAND(50))
  await ui.press({ key: 'more-threads' })
  expect(columns(await ui.drawn())[0]!.join('\n')).not.toContain('more')
  expect(columns(await ui.drawn())[0]).toContain('  ✓ Round tax per line to the cent') // the cut rows are back
  expect(flat(await ui.drawn())).toContain('[Show less]')
  await ui.press({ key: 'less' })
  expect(columns(await ui.drawn())[0]!.length).toBe(10) // back to normal
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
  // M, Threads: the current thread's head pinned on top at the full width, then its sub rows from the running task on.
  const m = screen(await band(), 150)
  console.log(['', 'Threads tab, M, 150 columns:', ...m].join('\n'))
  expect(m.slice(2)).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line  ·  now {80,}0 of 3 done  ·  sent \d+:\d\d$/),
    '  ❯ Adding a tax column to CartTable…',
    '    1 file',
    '  ● Add a tax column to CartTable',
    '  ○ Format it with formatMoney',
  ])
  // ▲ ▼ move the sub rows under the pinned head; at the top ▲ is dim text, not a button.
  expect(flat(await band())).toMatch(/ ▲ \n\[ ▼ \]/)
  await ui.press({ key: 'down' })
  const moved = screen(await band(), 150).slice(2)
  expect(moved[0]).toMatch(/^▸ Show tax on each cart line/) // still pinned
  expect(moved.slice(1)).toEqual(['    1 file', '  ● Add a tax column to CartTable', '  ○ Format it with formatMoney', '  ○ Add a cart table test'])
  expect(flat(await band())).toMatch(/\[ ▲ \]\n\[ ▼ \]/)
  await ui.press({ key: 'up' })
  expect(screen(await band(), 150)[3]).toBe('  ❯ Adding a tax column to CartTable…')
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
  expect(columns(await ui.drawn())[0]!.length).toBe(10)
  await ui.press({ key: 'size-collapsed' })
  expect(flat(await band())).not.toContain('───') // the status row alone: no rule, no body
  await $.command.run(whatcha('compact'))
  expect(await rows()).toHaveLength(5)
  await ui.unmount()
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
  const [list] = columns(await ui.drawn())
  // Current first, then finished threads newest first; no model here, so the title from the prompt names each.
  expect(list!.filter(l => /^\S/.test(l)).map(l => l.split(/ {3,}/)[0])).toEqual([
    '▸ Write short release notes 0.4.0 CHANGELOG.md  ·  now',
    '✓ Bump node CI workflow 22  ·  done',
    '✓ Why CI workflow fail repo  ·  answered',
    '✓ Add dark mode option src/settings.js  ·  done',
  ])
  expect(list).toContain('    2 tests pass  ·  1 file') // plain counts from the log

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
  const [left] = columns(await ui.drawn())
  expect(left![0]).toMatch(/plan · 5 steps  ·  sent \d+:\d\d$/)
  expect(left!.slice(1, 5)).toEqual(['  Plan · 5 steps', '    Steps', '      1. Reproduce on the live site', '      2. Confirm which store production uses'])
  expect(left).toContain('          1. live, not test')
  await ui.unmount()
  expect(wrap('a bb ccc dddd', 6)).toEqual(['a bb', 'ccc', 'dddd'])
})

test('thread name: the on-device model names a new thread in the background; without it the prompt title stays', async ($, on) => {
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
  expect(await status()).toContain('Now (0/1): Checkout timeout at Razorpay')
  // The thread row ends with the local clock time the prompt was sent, from the prompt.submit stamp.
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  expect(columns(await ui.drawn())[0]![0]).toMatch(new RegExp(`^▸ Checkout timeout at Razorpay  ·  now {2,}sent \\d+:\\d\\d$`))
  expect([sentLabel(new Date(2026, 0, 1, 10, 42).getTime()), sentLabel(new Date(2026, 0, 1, 9, 5).getTime())]).toEqual(['sent 10:42', 'sent 9:05'])
  await ui.unmount()
  await prompt('look at the server logs too') // a step of the same thread: no second model run
  expect(ran.filter(c => c.startsWith('ondevice-')).length).toBe(1)
  // No model (Apple Intelligence off): the title from the prompt stays.
  resetOnDevice()
  hasModel = false
  await prompt('new thing: fix the receipt snapshot test')
  await new Promise(r => setTimeout(r, 0))
  expect(await status()).toContain('▸ Now (0/2): Fix receipt snapshot test') // the status row uses the thread glyph
  const l = await $.ui.mount(BAND(120))
  await l.press({ key: 'tab-threads' })
  expect(columns(await l.drawn())[0]!.filter(r => /^\S/.test(r)).map(r => r.split(/ {3,}/)[0]))
    .toEqual(['▸ Fix receipt snapshot test  ·  now', '⏸ Checkout timeout at Razorpay  ·  paused'])
  await l.unmount()
  expect([threadName('Name: "Fix the tax"'), threadName(''), threadName('one two three four five six seven eight')]).toEqual(['Fix the tax', undefined, 'One two three four five six'])
})

const TAP = '> node --test\n\nTAP version 13\nok 1 - renders font size\nok 2 - snapshot\n1..2\n# tests 2\n# pass 2\n# fail 0\n'
