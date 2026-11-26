import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isQuietExit, DEMO_REPLY, demoObserved, planSteps, sentLabel, threadName, parseSummary, short, snippet, SUMMARY_SYSTEM, summaryInput, summaryPrompt, titleOf, testResult, isEngineText, dropEngineText, isTestCommand, noticeOf, onNotice, promptLine, promptSum, gistWords, sumSystem, daysAgo } from '../hooks/observe'
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
function engine(on: On, toolText = (_: Record<string, unknown>) => 'ok', toolResult = (_: Record<string, unknown>): unknown => ({}), store: Record<string, unknown> = {}, lateMs = 0) {
  let calls = 0
  let reply = SUMMARY
  let sent = ''
  let maxTokens = 0
  const clock = mock.clock(on, { now: T0 })
  // $.store kept in the test's own object, so a test reads back what the band saved.
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_, e) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('command.register', () => ({ value: { command: 'whatcha' } }))
  on('env.get', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => { const text = toolText(e as Record<string, unknown>); return { result: toolResult(e as Record<string, unknown>), text, ...(/^Exit code [1-9]/.test(text) ? { isError: true as const } : {}) } })
  on('model.complete', async (_, e) => {
    if (lateMs) await clock.sleep(lateMs) // Haiku answers late: the band shows its updating state meanwhile
    calls++
    sent = (e.system ?? '') + e.prompt
    maxTokens = e.maxTokens ?? 0
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  return { reply: (s: string) => { reply = s }, calls: () => calls, sent: () => sent, maxTokens: () => maxTokens, clock }
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
  expect(row).toContain('[ Artifacts ]')
  expect(row).not.toMatch(/\b[tsa]: |Enter|press /) // keys go to the prompt: no key labels
  await ui.press({ key: 'tab-threads' })
  await $.command.run(whatcha('all'))
  // One timeline at the full width, oldest first like the chat: every thread expanded, only the current one's plan unfolded.
  const body = timeline(await ui.drawn())
  expect(heads(body)).toEqual(['✓ Why is CI red?', '✓ Bump Node 20 to 22 in CI', '✗ Fix checkout tax rounding', '▸ Show tax on each cart line'])
  // Thread > task > plan step: every task and every step on its own row, one indent level each.
  expect(body.slice(0, 10)).toEqual([
    expect.stringMatching(/^✓ Why is CI red\? +┊  ↻  ┊ {11}┊ +\d+:\d\d, \d+d$/), // finished threads first; ↻, then an empty tests cell with no run
    '    ⎿ 1 helper started', // Claude replied: the turn's result line, in words
    expect.stringMatching(/^✓ Bump Node 20 to 22 in CI +┊  ↻  ┊ {11}┊ +\d+:\d\d, \d+d$/),
    '  ✓ Use Node 22 in the CI workflow',
    '    ⎿ 2 files changed · 1 commit',
    expect.stringMatching(/^✗ Fix checkout tax rounding +┊  ↻  ┊    11✓ 1✗ ┊ +\d+:\d\d, \d+d$/), // passes and fails: the compact "11✓ 1✗"
    '  ✓ Round tax per line to the cent',
    '  ● Fix the two failing tax tests',
    '  ✗ Update the receipt snapshot',
    '  ❯ Fixing the two failing tax tests…',
  ])
  expect(body.slice(10)).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line {20,}┊  ↻  ┊ {11}┊ +\d+:\d\d, \d+d$/),
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
  expect(flat(await ui.drawn())).toContain('[ Show less ]')
  await ui.press({ key: 'less' })
  expect(timeline(await ui.drawn()).length).toBe(4) // back to normal
  await ui.unmount()
})

test('sizes: S is the one row, M the 6 most useful lines of the tab, L up to 20% of the rows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND(50, 155))
  const band = async () => (await ui.drawn() as unknown as N).children[0]!
  const rows = async () => ((await band()).children[2]!.children as unknown as R[]).map(rowText)
  expect(flat(await band())).toMatch(/\[ Threads \]\n\[ Summary \]\n\[ Artifacts \]\n┊\n\[ S \]\n\[ M \]\n\[ L \]\n┊\n\[ 🤖 \]\n\[ ▾ \]/) // padded 1 a side, faint ┊ between groups
  await ui.press({ key: 'size-compact' })
  // M, Threads: the top 6 rows of the timeline, the current thread first.
  const m = screen(await band(), 150)
  console.log(['', 'Threads tab, M, 150 columns:', ...m].join('\n'))
  // Real height: status row + hairline + 6 body rows, inside the engine's maxRows, so it never scrolls a row away.
  expect(m).toHaveLength(8)
  // Opens on the newest: the current thread's head pinned on top, its latest prompt and running line lowest.
  expect(subText(m.slice(2))).toEqual([
    expect.stringMatching(/^▸ Show tax on each cart line {20,}┊  ↻  ┊ +┊ +\d+:\d\d, \d+d$/),
    '  ● Add a tax column to CartTable',
    '  ○ Format it with formatMoney',
    '  ○ Add a cart table test',
    expect.stringMatching(/^  › Keep the tax column narrow/),
    '  ❯ Adding a tax column to CartTable…',
  ])
  // ⤒ ▲ go back to older rows, ▼ ⤓ toward the newest; at the newest ▼ ⤓ are dim text, not buttons.
  expect(flat(await band())).toMatch(/\[ ⤒ \]\n\[ ▲ \]\n ▼ \n ⤓ /)
  // A click moves a page (6 rows less 1); deep in a thread, that thread's head stays on the top row.
  for (let i = 0; i < 2; i++) await ui.press({ key: 'up' })
  const deep = subText(screen(await band(), 150).slice(2))
  expect(nameCol(deep[0]!)).toBe('✗ Fix checkout tax rounding')
  expect(deep.slice(1)).toEqual(['  ❯ Fixing the two failing tax tests…', expect.stringMatching(/^▸ Show tax on each cart line /), '  Plan · 4 steps', '    Steps', '      1. Add a Tax column to CartTable.ts'])
  await ui.press({ key: 'top' })
  expect(heads(screen(await band(), 150).slice(2))).toEqual(['✓ Why is CI red?', '✓ Bump Node 20 to 22 in CI', '✗ Fix checkout tax rounding'])
  expect(flat(await band())).toMatch(/ ⤒ \n ▲ \n\[ ▼ \]\n\[ ⤓ \]/)
  await ui.press({ key: 'bottom' })
  expect(screen(await band(), 150)).toEqual(m)
  await ui.press({ key: 'tab-summary' }) // a tab keeps the band compact
  // M shows the same columns as L, one row per task: head, 4 board rows, work left.
  const sum = screen(await band(), 150).slice(2)
  expect(sum).toHaveLength(6)
  expect(sum[1]).toMatch(/^Left 3 +Active 1 +Stuck 1 +Done 2$/)
  expect(sum[5]).toMatch(/^Work left: /)
  await ui.press({ key: 'tab-artifacts' })
  const arts = await rows()
  expect(arts).toHaveLength(6)
  expect(arts[0]).toMatch(/Artifacts  ·  click copies the link\s+Created  Modified$/)
  await ui.press({ key: 'size-expanded' })
  await ui.press({ key: 'tab-threads' })
  expect(timeline(await ui.drawn()).length).toBe(10)
  await ui.press({ key: 'size-collapsed' })
  expect(flat(await band())).not.toContain('───') // the status row alone: no rule, no body
  await $.command.run(whatcha('compact'))
  expect(await rows()).toHaveLength(6)
  await ui.unmount()
  // A 7-row slot under 120 columns: the header takes 2 rows, so M draws 4 and the band never scrolls a row away.
  const slot = { ...BAND(50, 105), props: { ...BAND(50, 105).props, maxRows: 7 } }
  const short = await $.ui.mount(slot)
  await short.press({ key: 'tab-threads' })
  expect(screen((await short.drawn() as unknown as N).children[0], 100)).toHaveLength(7)
  await short.unmount()
})

test('Summary board: 4 columns at 150, 2 x 2 at 100, 1 at 60; long lines wrap to 2 in a column; M keeps 6 rows', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  await $.command.run(whatcha('summary'))
  // The board is [head, ...rows of columns, work left]; each column is about 30+ characters wide.
  const board = async (columns: number) => {
    const ui = await $.ui.mount(BAND(50, columns))
    const tree = await ui.drawn()
    const kids = bodyOf(tree).children as unknown as { children: { props: { width: number } }[] }[]
    const shown = screen(bodyOf(tree), columns - 5)
    await ui.unmount()
    return { widths: kids.slice(1, -1).map(r => r.children.map(c => c.props.width)), shown }
  }
  const wide = await board(150)
  expect(wide.widths).toEqual([[34, 34, 34, 34]])
  // "Waiting on the one-cent receipt fix." is wider than its column: it wraps to a second line, never "fix…".
  expect(wide.shown.join('\n')).toMatch(/Waiting on the one-cent/)
  expect(wide.shown.join('\n')).not.toMatch(/…/)
  expect((await board(100)).widths).toEqual([[46, 46], [46, 46]])
  expect((await board(60)).widths).toEqual([[55], [55], [55], [55]])
  // M: 6 rows, the same 4 columns, as many items as fit.
  await $.command.run(whatcha('compact'))
  const m = await $.ui.mount(BAND(50, 150))
  const rows = screen(bodyOf(await m.drawn()), 145)
  expect(rows).toHaveLength(6)
  expect(rows[1]).toMatch(/^Left \d +Active 1 +Stuck 1 +Done 2/)
  await m.unmount()
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
  // Tests sit in the tests column on their turn's prompt row, never in the result line.
  expect(screen(bodyOf(await ui.drawn()), 150)).toContainEqual(expect.stringMatching(/^  › Run npm test .*┊  ↻  ┊  2 ✓ Pass ┊ +\d+:\d\d, \d+d$/))
  expect(list.join('\n')).not.toMatch(/tests passed/)

  await ui.press({ key: 'tab-summary' })
  const sent = m.sent()
  // The compact digest: one line per thread with its side-trip parent and counts, then the current thread's last test.
  expect(sent).toContain('#1 Add dark mode option src/settings.js [done] 1 files\n#2<1 Why CI workflow fail repo [answered]\n')
  expect(sent).toContain('#3<2 Bump node CI workflow 22 [done] 1 files\n#4 Write short release notes 0.4.0 CHANGEL… [done] 1 files')
  expect(sent).toContain('now #4\n\nReply') // npm test ran in another thread: no test line
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
  expect(left[0]).toMatch(/^▸ Customer has a checkout issue +┊  ↻  ┊ +┊ +\d+:\d\d, \d+d$/)
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
  // 🤖: the status row and the thread row show the model's gist; 👤 what the owner typed (tags and "okay so um" go).
  const said = 'The customer says checkout goes to razorpay and then it just sits there and times out, can you look'
  expect(await status()).toContain('Now (0/1): Checkout timeout at Razorpay')
  // The thread row ends with the local clock time the prompt was sent, from the prompt.submit stamp.
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  expect(timeline(await ui.drawn())[0]).toMatch(/^▸ Checkout timeout at Razorpay +┊  ↻  ┊ +┊ +\d+:\d\d, \d+d$/)
  // 👤 flips every row to the prompt as typed, 🤖 back to the gist.
  await ui.press({ key: 'raw' })
  expect(flat(await ui.drawn())).toContain('[ 👤 ]')
  expect(flat(await ui.drawn())).toContain(`Now (0/1): ${said}`)
  expect(timeline(await ui.drawn())[0]).toMatch(new RegExp(`^▸ ${said} +┊  ↻  ┊ +┊ +\\d+:\\d\\d, \\d+d$`))
  await ui.press({ key: 'raw' })
  expect(flat(await ui.drawn())).toContain('[ 🤖 ]')
  expect([sentLabel(new Date(2026, 0, 1, 10, 42).getTime()), sentLabel(new Date(2026, 0, 1, 9, 5).getTime())]).toEqual(['sent 10:42', 'sent 9:05'])
  await ui.unmount()
  await prompt('look at the server logs too') // a step of the same thread: no second model run
  // One model run names the thread, one writes the long prompt's summary; the short later step asks for neither.
  expect(ran.filter(c => c.startsWith('ondevice-')).length).toBe(2)
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
  expect(heads(timeline(await l.drawn()))).toEqual([`⏸ Checkout timeout at Razorpay`, '⏸ Checkout timeout at Razorpay', '▸ Fix the receipt snapshot test'])
  await l.unmount()
  expect([threadName('Name: "Fix the tax"'), threadName(''), threadName('one two three four five six seven eight')]).toEqual(['Fix the tax', undefined, undefined]) // 8 words: never cut to 6, a cut echo is a fragment
})

test('a new long prompt gets its gist with no toggle: "…" while the model runs, one retry in fewer words; 👤 flips it; S fits at 100', async ($, on) => {
  engine(on)
  const sent: number[] = []
  let open = () => {}
  const gate = new Promise<void>(r => { open = r })
  on('fs.read', () => ({ value: 'swift source' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', async (_, e) => {
    let stdout = ''
    if (e.argv[0]!.includes('ondevice-')) {
      const { system, text } = JSON.parse(String(e.init?.stdin)) as { system: string; text: string }
      sent.push(text.length)
      await gate
      const two = text.includes('second')
      // A long dictated prompt often gets a 12+ word "gist": too long, so the model is asked again in fewer words.
      stdout = system.includes('3 to 5') ? (two ? 'Gist every new prompt' : 'Fix missing prompt gists')
        : /about \d+ words/.test(system) ? (two ? 'Make every new prompt get its gist' : 'Diagnose fresh prompt gist failure, fix queue, redraw, limit input, retry model, show raw prompt')
        : 'Band gist fixes'
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  resetOnDevice()
  const settle = () => new Promise(r => setTimeout(r, 20))
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const said = 'okay so the gist band often shows nothing for a new prompt, I dictate a big prompt and the threads view shows nothing new and the robot button changes nothing, so find why and fix it'
  const dictated = `${said}. ${'and here is a lot more dictated detail about the gist band and the prompt rows '.repeat(60)}`
  const draw = async (columns: number, size?: string) => {
    const ui = await $.ui.mount(BAND(50, columns + 5))
    if (size) {
      await ui.press({ key: size })
      await ui.press({ key: 'tab-threads' })
    }
    const s = screen(await ui.drawn(), columns).filter(Boolean)
    await ui.unmount()
    return s
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt('fix the gist band for new prompts')
  await prompt(dictated)
  // Before the model answers: the spinner line, then the prompt as typed (dim), and the spinner on the status row.
  // One row, filled in place by the gist: no row moves.
  expect((await draw(150, 'size-compact')).slice(-2)).toEqual([expect.stringMatching(/^▸ /), expect.stringMatching(/^  › \S summarizing…  The gist band often shows nothing.*… ┊/)])
  expect((await draw(100))[0]).toMatch(/^▸ Now \(0\/1\): \S summarizing…$/)
  open()
  await settle()
  // The answer lands and redraws with no click: 4000 chars of the 5000 sent, cut, never skipped.
  expect(Math.max(...sent)).toBe(4000)
  expect(subText((await draw(150, 'size-compact')).slice(2)).at(-1)).toBe('  › Fix missing prompt gists')
  await prompt(`${said}, second try with more words`)
  await settle()
  const m = await draw(150, 'size-compact')
  console.log(['', 'Threads, M, 150 columns, after a long prompt:', ...m].join('\n'))
  expect(subText(m.slice(2)).slice(-2)).toEqual(['  › Fix missing prompt gists', '  › Make every new prompt get its gist'])
  // S: the 3-5 word brief, inside 100 columns; the buttons keep their own row.
  const s = await draw(100)
  console.log(['', 'S, 100 columns, 🤖:', ...s].join('\n'))
  expect(s[0]).toBe('▸ Now (0/1): Gist every new prompt')
  // 👤: every row shows the prompt as typed, cut at the width; 🤖 brings the gists back.
  const ui = await $.ui.mount(BAND(50, 105))
  await ui.press({ key: 'raw' })
  const raw = screen(await ui.drawn(), 100)
  console.log(['', 'S, 100 columns, 👤:', ...raw].join('\n'))
  expect(raw[0]).toMatch(/^▸ Now \(0\/1\): The gist band often shows nothing for a new prompt, I dictate a big prompt and the thr…$/) // cut at 100
  expect(raw.every(l => [...l].length <= 100)).toBe(true)
  expect(raw[1]).toContain('Threads  Summary  Artifacts')
  await ui.press({ key: 'size-compact' })
  await ui.press({ key: 'tab-threads' })
  expect(subText(screen(await ui.drawn(), 150).filter(Boolean).slice(2)).slice(-2)).toEqual([expect.stringMatching(/^  › The gist band often shows nothing/), expect.stringMatching(/^    \S/)])
  await ui.press({ key: 'raw' })
  expect(subText(screen(await ui.drawn(), 150).filter(Boolean).slice(2)).at(-1)).toBe('  › Make every new prompt get its gist')
  await ui.unmount()
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

test('turns: prompts sent while Claude works stack; one result line after the reply, none before', async ($, on) => {
  engine(on, e => (String(e.command ?? '').includes('npm test') ? '# pass 18\n# fail 0' : 'ok'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const reply = () => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  await prompt('[Image #1] here reduce padding, its too much on the icon tiles')
  const ui = await $.ui.mount(BAND(120, 155))
  await ui.press({ key: 'tab-threads' })
  await ui.press({ key: 'size-compact' })
  // Picks pasted from an options page: same thread, its own row right away, before Claude does anything.
  await prompt('- Exact: 1 Yellow on blue tile\n- Colors: 1 Yellow with dark outline\n- Morphed: No pick')
  expect(timeline(await ui.drawn())).toEqual([
    expect.stringMatching(/^▸ Here reduce padding, its too much on the icon tiles +┊  ↻  ┊ +┊ +\d+:\d\d, \d+d$/),
    expect.stringMatching(/^  › Exact: 1 Yellow on blue tile - Colors: .* Morphed: No pick$/),
  ])
  await $.tool.call({ tool: 'Edit', file_path: '/w/spec/icons.md', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/Tile.tsx', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await prompt('and keep the tile corners round') // sent mid-work: it stacks, and no result line yet
  const stacked = [expect.stringMatching(/^  › Exact: /), '  › And keep the tile corners round']
  expect(timeline(await ui.drawn()).slice(1)).toEqual(stacked)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Round the tiles"' } as never)
  await reply()
  // One line under the stack, for all the work since the first prompt; no command or path in it.
  const after = timeline(await ui.drawn())
  expect(after.slice(1)).toEqual([...stacked, '    ⎿ 2 files changed · 1 commit'])
  console.log(['', 'Threads, M, 150 columns, stacked prompts and the result line:', ...screen(await ui.drawn(), 150)].join('\n'))
  expect(after.join('\n')).not.toMatch(/\[Image|icons\.md|Tile\.tsx|npm|git/)
  // A new prompt after the reply starts a new turn: its row, and no line until Claude replies again.
  await prompt('now the dark tile')
  expect(timeline(await ui.drawn()).slice(-2)).toEqual(['    ⎿ 2 files changed · 1 commit', '  › Now the dark tile'])
  await ui.unmount()
  // An on-device reply cut to 6 words ends mid-clause: not a name.
  expect([threadName('[Image #1] here reduce padding, its'), threadName('here reduce padding on tiles')]).toEqual([undefined, 'Here reduce padding on tiles'])
})

test('the result line shows no code, files or tests: "2 files changed · 1 commit", even for a heredoc commit', async ($, on) => {
  engine(on, e => (String(e.command ?? '').includes('swift test') ? '# pass 4\n# fail 0' : 'ok'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'make the toy kit tests pass', wait: false, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/pingeither/index.html', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/w/Tests/NetToysKitTests/KitTests.swift', content: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: "python3 - <<'EOF'\np='Tests/NetToysKitTests/KitTests.swift'\nEOF\nswift test" } as never)
  await $.tool.call({ tool: 'Bash', command: "git commit -m \"$(cat <<'EOF'\nFix the kit tests\n\nBody.\nEOF\n)\"" } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  const rows = timeline(await ui.drawn()).slice(1)
  expect(rows).toEqual(['    ⎿ 2 files changed · 1 commit'])
  expect(rows.join('\n')).not.toMatch(/index\.html|NetToys|python3|EOF|<</)
  await ui.unmount()
})

test('no answer: the spinner, "retrying, try 1 of 3" after a miss, asked again after 5 s; 3 misses show the prompt; ↻ asks with earlier prompts; a press on a prompt not drawn in the chat says so', async ($, on) => {
  const m = engine(on)
  let misses = 1
  const asked: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: unknown }).text)); return { value: undefined } })
  on('fs.read', () => ({ value: 'swift source' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    let out = { exitCode: 0, stdout: '' }
    if (e.argv[0]!.includes('ondevice-')) {
      const { system, text } = JSON.parse(String(e.init?.stdin)) as { system: string; text: string }
      if (/gist|about \d+ words/.test(system)) {
        asked.push(text)
        // exit 1: a one-off miss (the helper failed or timed out), not "no model on this Mac".
        out = misses-- > 0 ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: text.includes('Earlier prompts') ? 'Retry gists with chat context' : 'Fix the band gist retry' }
      }
    }
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...out } }
  })
  resetOnDevice()
  const settle = () => new Promise(r => setTimeout(r, 20))
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  const lastRows = async (n: number) => {
    const ui = await $.ui.mount(BAND(50, 155))
    await ui.press({ key: 'size-compact' })
    await ui.press({ key: 'tab-threads' })
    const s = subText(screen(await ui.drawn(), 150).filter(Boolean)).slice(-n)
    await ui.unmount()
    return s
  }
  const last = async () => (await lastRows(1))[0]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt('fix the band please')
  const long = 'the band gist sometimes never shows up for a prompt and stays raw, find out why and retry it'
  await prompt(long)
  await settle()
  // A miss: the spinner says which try, then the prompt as typed (dim), on the one row the gist will take.
  expect(await lastRows(2)).toEqual([expect.stringMatching(/^▸ Fix the band please/), expect.stringMatching(/^  › \S retrying, try 1 of 3  The band gist sometimes never shows up for a prompt and stays raw, find out why and retry …$/)])
  await m.clock.advance(5_000)
  await settle()
  expect(await last()).toBe('  › Fix the band gist retry')
  // ↻: the same prompt again, with the chat's earlier prompts before it.
  const ui = await $.ui.mount(BAND(50, 155))
  await ui.press({ key: 'tab-threads' })
  await ui.press({ key: 'redo-1' })
  await settle()
  expect(asked.at(-1)).toBe('Earlier prompts in this chat: "Fix the band please". The request: ' + long)
  expect(await last()).toBe('  › Retry gists with chat context')
  await ui.press({ key: 'jump-0' })
  expect(toasts).toEqual(['That prompt is not drawn in the chat yet'])
  await ui.unmount()
  // Three more misses after the first: the prompt shows as typed, never the spinner for good.
  misses = 4
  await prompt('and when the band helper never answers at all, show the prompt itself after the retries')
  for (const ms of [0, 5_000, 20_000, 60_000]) { await m.clock.advance(ms); await settle() }
  expect(await last()).toBe('  › And when the band helper never answers at all, show the prompt itself after the retries')
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
    // The 3 columns sit on every row, thread rows and sub rows alike, so every ┊ is in the same place top to bottom.
    expect(new Set(list.map(bars)).size).toBe(1)
    expect(list.every(l => [...l].length <= cols)).toBe(true)
    const heads = list.filter(l => /^\S/.test(l))
    expect(heads).toHaveLength(2)
    expect(heads[0]).toMatch(/… ┊  ↻  ┊ {11}┊ +\d+:\d\d, \d+d$/)
    expect(heads[1]).toMatch(/… ┊  ↻  ┊ {11}┊ +\d+:\d\d, \d+d$/)
    // The tests ran after the stacked prompt: its row has them.
    expect(list.filter(l => /┊  ↻  ┊   88✓ 12✗ ┊ +\d+:\d\d, \d+d$/.test(l))).toHaveLength(1)
    // Claude replied to the first thread: its result line, the time in the column. The second has no reply yet.
    expect(list).toContainEqual(expect.stringMatching(/^    ⎿ 3 files changed · 5 commits +┊     ┊ {11}┊ +\d+:\d\d, \d+d$/))
    expect(list.filter(l => l.includes('⎿'))).toHaveLength(1)
    // The 2-line prompt wraps inside the left area: its second row ends before the first ┊ too.
    const p = list.findIndex(l => l.startsWith('  › And make the index file'))
    expect(list[p]).toMatch(/ ┊  ↻  ┊   88✓ 12✗ ┊ +\d+:\d\d, \d+d$/)
    expect(list[p + 1]).toMatch(/^    \S.* +┊     ┊ {11}┊$/)
    await ui.unmount()
  }
})

test('test counts: "18 ✓ Pass" when all pass, "3 ✗ Fail" when all fail, "18✓ 1✗" for both; 1000 and up as "1.2k"', () => {
  expect(testCell('npm test: 18 pass, 1 fail')).toEqual([['18✓', 'success'], [' 1✗', 'error']])
  expect(testCell('npm test: 18 pass, 0 fail')).toEqual([['18 ✓ Pass', 'success']])
  expect(testCell('npm test: 0 pass, 3 fail')).toEqual([['3 ✗ Fail', 'error']])
  expect(testCell('npm test: 1234 pass, 0 fail')).toEqual([['1.2k ✓ Pass', 'success']])
  expect([testCell('npm test'), testCell('npm test: 0 pass, 0 fail')]).toEqual([[], []])
})

test('older prompts: one line, the on-device gist or the cut prompt, in M and L; only the newest gets 2; with no reply yet the prompts stack, no result line', async ($, on) => {
  const m = engine(on, e => (String(e.command ?? '').includes('test') ? '# pass 4\n# fail 0' : 'ok'))
  let reply = 'Auto-update the index on rule changes.'
  on('fs.read', () => ({ value: 'swift source' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => {
    const stdin = String(e.init?.stdin ?? '')
    const gist = /gist|about \d+ words/.test(stdin)
    const out = e.argv[0]!.includes('ondevice-') ? { exitCode: 0, stdout: !gist ? 'Graph rule for references' : stdin.includes('graph rule') ? 'Index global rule references per project' : reply } : { exitCode: 0, stdout: '' }
    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...out } }
  })
  resetOnDevice()
  const settle = () => new Promise(r => setTimeout(r, 20))
  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const long = 'and make the index file update itself every time a rule file changes, and show me which projects point at each global rule'
  await prompt('can you create a graph rule which keeps an index of references from the global rules to the projects')
  await m.clock.advance(60_000)
  await prompt(long)
  await settle()
  await m.clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await m.clock.advance(60_000)
  reply = long // an echo of the prompt is no gist: the prompt stays, cut at the first ┊
  await prompt(`${long} too`)
  await settle()
  await m.clock.advance(60_000)
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/index.ts', old_string: 'a', new_string: 'b' } as never)
  await prompt('one more thing: also list the projects with no rules at all, and keep that list sorted by name please')
  await settle()
  const ui = await $.ui.mount(BAND(120, 125))
  await ui.press({ key: 'tab-threads' })
  const list = screen(bodyOf(await ui.drawn()), 120)
  const rows = subText(list)
  // L: the thread name is the gist of its long first prompt, on one row.
  expect(nameCol(rows[0]!)).toBe('▸ Index global rule references per project')
  expect(rows.slice(1, 3)).toEqual([
    '  › Auto-update the index on rule changes', // an older prompt: its gist, one row
    expect.stringMatching(/^  › And make the index file update itself every time .*…$/), // a bad gist: the cut prompt
  ])
  // The newest prompt of the timeline is the only one on 2 rows.
  expect(rows.slice(3)).toEqual([expect.stringMatching(/^  › One more thing: also list/), expect.stringMatching(/^    \S/)])
  expect(list.filter(l => /┊  4 ✓ Pass ┊/.test(l))).toHaveLength(1) // green, alone: no fail count beside it
  // Sub rows in time order, oldest first.
  const times = list.slice(1).map(l => l.match(/(\d+):(\d\d)$/)).filter(Boolean).map(x => +x![1]! * 60 + +x![2]!)
  expect(times).toEqual([...times].sort((a, b) => a - b))
  // M: the same gists; the 5 rows fit, so no ▲.
  await ui.press({ key: 'size-compact' })
  const mRows = subText(screen(bodyOf(await ui.drawn()), 120))
  expect(mRows).toHaveLength(5)
  expect(mRows.slice(0, 2).map(nameCol)).toEqual(['▸ Index global rule references per project', '  › Auto-update the index on rule changes'])
  ui.unmount()
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
  expect([argv[0]![0], argv[0]!.at(-1)]).toEqual(['sh', 'undefined/.claude/projects/-w-my-app/abc.jsonl']) // jq cuts the file to its user lines
  const ui = await $.ui.mount(BAND(120))
  await ui.press({ key: 'tab-threads' })
  const list = timeline(await ui.drawn())
  expect(heads(list)).toEqual(['✓ Fix the login redirect bug', '▸ Write the release notes'])
  expect(list[0]).toMatch(/^✓ Fix the login redirect bug +┊  ↻  ┊ +┊ +9:05, 0d$/)
  expect(list.find(l => l.startsWith('▸'))).toMatch(/^▸ Write the release notes +┊  ↻  ┊ +┊ +9:20, 0d$/)
  // The next prompt means Claude replied: the result line takes its last tool result's time from the file, 9:08.
  expect(screen(bodyOf(await ui.drawn()), 150)).toContainEqual(expect.stringMatching(/^    ⎿ 1 file changed · 1 commit · took 3m +┊     ┊ {11}┊ +9:08, 0d$/))
  await ui.unmount()
})

test('false stuck: a grep with no match after the work, then a reply, leaves the thread done and Haiku sees no error', async ($, on) => {
  // The owner's case: tests pass 25/0, the fix is committed, then a check `git log | grep -ci co-authored` prints 0, exit 1.
  const m = engine(on, e => {
    const c = String(e.command ?? '')
    return c.includes('plugin test') ? '# pass 25\n# fail 0' : c.includes('grep -ci') ? 'Exit code 1\n0' : c.includes('build') ? 'Exit code 2\nError: cannot find module x' : 'ok'
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the realtime update bug, updates lag sometimes', wait: false, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/w/hooks/register.tsx', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' } as never) // a real error, fixed by the next steps
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix realtime band updates"' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git log -1 --format=%B | grep -ci "co-authored"' } as never)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'a', reason: 'answer' } as never)
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  expect(heads(timeline(await ui.drawn()))).toEqual(['▸ Fix the realtime update bug, updates lag sometimes']) // current: ▸, never ✗
  await ui.press({ key: 'tab-summary' })
  expect(m.sent()).toContain('[done]')
  expect(m.sent()).not.toContain('error:')
  await ui.unmount()
  // Exit 1 of a pipeline ending in grep, rg, test, [, diff or cmp with no error text is "no match", not a failure.
  expect([
    isQuietExit('git log | grep -ci x', 'Exit code 1\n0'), isQuietExit('test -f a && diff a b', 'Exit code 1\n< x\n> y'),
    isQuietExit('grep x missing.txt', 'Exit code 1\ngrep: missing.txt: No such file or directory'),
    isQuietExit('npm run build', 'Exit code 1\n'), isQuietExit('grep x f', 'Exit code 2\n'),
  ]).toEqual([true, true, false, false, false])
})

test('view: size, 🤖/👤 and tab come back from $.store in a new session, global by default', async ($, on) => {
  const store: Record<string, unknown> = { view: { mode: 'compact', raw: true, tab: 'artifacts' } }
  engine(on, undefined, undefined, store)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND())
  expect(flat(await ui.drawn())).toMatch(/\[ 👤 \]/)
  expect(screen(bodyOf(await ui.drawn()), 150)[0]).toMatch(/Artifacts/)
  await ui.press({ key: 'size-expanded' })
  await ui.press({ key: 'raw' })
  expect(store['view']).toEqual({ mode: 'expanded', raw: false, tab: 'artifacts' })
  await ui.unmount()
})

test('view per project: a project saves its own view, starting from the global one', { options: { rememberView: 'per project' } }, async ($, on) => {
  const store: Record<string, unknown> = { view: { mode: 'compact', raw: false, tab: 'threads' } }
  engine(on, undefined, undefined, store)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND())
  expect(flat(await ui.drawn())).toContain('───') // M from the global view
  await ui.press({ key: 'size-collapsed' })
  expect(store['view:/p']).toEqual({ mode: 'collapsed', raw: false, tab: 'threads' })
  expect(store['view']).toEqual({ mode: 'compact', raw: false, tab: 'threads' }) // the global view stays
  await ui.unmount()
})

test('false stuck 2: a test script that fails to start, fixed by another command, never blocks its task', async ($, on) => {
  const m = engine(on, e => {
    const c = String(e.command ?? '')
    return c === 'npm test' ? 'Exit code 1\nnpm error Missing script: "test"' : c.includes('| grep') ? 'Exit code 1\n' : 'ok'
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'set up the test script for the band', wait: false, origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Setup test script', status: 'in_progress', activeForm: 'Setting up the test script' }] } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never) // no script yet: a failed step, not a failed test
  await $.tool.call({ tool: 'Bash', command: 'npm pkg set scripts.test="node --test"' } as never) // the fix, no commit
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test . 2>&1 | grep -E "^\\(fail\\)"' } as never) // no failures: grep finds nothing
  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  const rows = timeline(await ui.drawn())
  expect(rows.some(r => r.includes('✗'))).toBe(false)
  await ui.press({ key: 'tab-summary' })
  expect(m.sent()).toContain(' doing: Setup test script')
  expect(m.sent()).not.toMatch(/error:|test: fail|stuck:/)
  await ui.unmount()
})

test('Summary board: every column header shows; an empty one says so in one dim line, in 4, 2 x 2, 1 column and M', async ($, on) => {
  engine(on) // Haiku: one active task, one left; Done and Stuck are empty
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the login page', wait: false, origin: { kind: 'composer' } } as never)
  const draw = async (columns: number) => {
    const ui = await $.ui.mount(BAND(50, columns))
    await ui.press({ key: 'tab-summary' })
    const rows = screen(bodyOf(await ui.drawn()), columns - 5)
    await ui.unmount()
    return rows
  }
  const wide = await draw(150)
  expect(wide[1]).toMatch(/^Left 1 +Active 1 +Stuck 0 +Done 0$/)
  expect(wide[2]).toMatch(/^○ Write a test +● Fix login +✓ nothing stuck +nothing finished yet$/)
  const two = await draw(100)
  console.log(['', 'Summary, 150 columns:', ...wide, '', 'Summary, 2 x 2, 100 columns:', ...two].join('\n'))
  // 2 x 2, a kanban read left to right then down: Left, Active on top, Stuck, Done below.
  expect(two.filter(l => /^(Left|Stuck) \d/.test(l))).toEqual([expect.stringMatching(/^Left 1 +Active 1$/), expect.stringMatching(/^Stuck 0 +Done 0$/)])
  const mid = two.join('\n')
  for (const x of ['Left 1', 'Active 1', 'Stuck 0', '✓ nothing stuck', 'Done 0', 'nothing finished yet']) expect(mid).toContain(x)
  // One column: the empty groups share one line.
  expect(await draw(60)).toContain('Stuck: nothing  ·  Done: nothing')
  await $.command.run(whatcha('compact'))
  const m = await draw(150)
  expect(m.length).toBeLessThanOrEqual(6)
  expect(m[1]).toMatch(/^Left 1 +Active 1 +Stuck 0 +Done 0$/)
  expect(m[2]).toMatch(/^○ Write a test +● Fix login +✓ nothing stuck +nothing finished yet$/)
})

test('Summary board is a kanban: newest first in every column, whatever order Haiku gives; +N more cuts the oldest', async ($, on) => {
  const m = engine(on, e => (e.tool === 'TaskCreate' ? 'ok' : 'ok'), e => (e.tool === 'TaskCreate' ? { task: { id: String(e.subject).at(-1) } } : {}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'build the eight steps of the import', wait: false, origin: { kind: 'composer' } } as never)
  // Eight tasks made a minute apart: step 1 the oldest, step 8 the newest.
  for (let i = 1; i <= 8; i++) {
    await m.clock.advance(60_000)
    await $.tool.call({ tool: 'TaskCreate', subject: `Import step ${i}`, description: '' } as never)
  }
  // Haiku lists them oldest first; the band sorts by the times it holds.
  m.reply(JSON.stringify({ p: 10, t: Array.from({ length: 8 }, (_, i) => [`Step ${i + 1}`, 'r', `Do import step ${i + 1}.`, `#1.${i + 1}`]), b: [] }))
  const ui = await $.ui.mount(BAND(50, 150))
  await ui.press({ key: 'tab-summary' })
  const left = screen(bodyOf(await ui.drawn()), 145).slice(1).map(l => l.slice(0, 34).trim())
  expect(left.slice(0, 3)).toEqual(['Left 8', '○ Step 8', '○ Step 7'])
  await ui.press({ key: 'size-compact' })
  const mRows = screen(bodyOf(await ui.drawn()), 145)
  expect(mRows.slice(1, -1).map(l => l.slice(0, 34).trim())).toEqual(['Left 8', '○ Step 8', '○ Step 7', '+6 more'])
  // A later change moves a task to the top: step 2 is updated now.
  await m.clock.advance(60_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)
  m.reply(JSON.stringify({ p: 10, t: Array.from({ length: 8 }, (_, i) => [`Step ${i + 1}`, 'r', '', `#1.${i + 1}`]), b: [] }))
  await ui.press({ key: 'refresh' })
  expect(screen(bodyOf(await ui.drawn()), 145).map(l => l.slice(0, 34).trim())[2]).toBe('○ Step 2')
  await ui.unmount()
})

test('gist length follows the band and the prompt: a long prompt fills the row, a short one is not padded; a reply wider than the row is dropped', () => {
  const long = Array(90).fill('word').join(' ')
  expect(gistWords(130, long)).toBe(18)
  expect(gistWords(70, long)).toBe(10)
  expect(gistWords(130, Array(30).fill('word').join(' '))).toBe(10)
  expect(gistWords(130, 'short prompt')).toBe(6)
  expect(sumSystem(130, long)).toContain('about 18 words (about 126 characters)')
  const reply = 'Make the band gist use the full row width'
  expect(promptSum(reply, 'long prompt text here', 11, 70)).toBe(reply)
  expect(promptSum(reply, 'long prompt text here', 11, 20)).toBeUndefined()
})

test('a gist asked while Threads is hidden still gets the wide row: the band measures it on every tab', async ($, on) => {
  engine(on)
  const systems: string[] = []
  on('fs.read', () => ({ value: 'swift source' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', async (_, e) => {
    if (e.argv[0]!.includes('ondevice-')) systems.push((JSON.parse(String(e.init?.stdin)) as { system: string }).system)
    return { value: { exitCode: 0, stdout: 'Fix header numbers, divider color options, more red shades, box borders', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  resetOnDevice()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND(50, 160))
  await ui.press({ key: 'tab-artifacts' })
  await ui.drawn()
  await $.prompt.submit({ text: 'fix the header numbers and give divider color options and more shades of red and fix the box borders '.repeat(3), wait: false, origin: { kind: 'composer' } } as never)
  await new Promise(r => setTimeout(r, 20))
  await ui.unmount()
  // 160 columns less the 3 meta columns: about 17 words, not the 8 of the 60-column default.
  expect(systems.find(s => s.startsWith('Summarize'))).toContain('about 17 words')
})

test('the time cell counts whole calendar days back: 0d today, 1d even 5 minutes across midnight', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
  expect([daysAgo(at(27, 9), at(27, 23)), daysAgo(at(26, 23, 58), at(27, 0, 3)), daysAgo(at(25, 1), at(27, 23)), daysAgo(at(27, 9), at(27, 8))]).toEqual([0, 1, 2, 0])
})

test('M keeps its full height on every tab, even with one row to show', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(BAND(50, 160))
  await ui.press({ key: 'size-compact' })
  for (const tab of ['tab-threads', 'tab-summary', 'tab-artifacts']) {
    await ui.press({ key: tab })
    const main = (bodyOf(await ui.drawn()) as { props?: { height?: number } })
    expect([tab, main.props?.height]).toEqual([tab, 6])
  }
  await ui.unmount()
})
