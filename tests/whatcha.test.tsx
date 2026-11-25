import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEMO_REPLY, demoObserved, parseSummary, short, snippet, SUMMARY_SYSTEM, summaryInput, summaryPrompt, titleOf, isEngineText, dropEngineText, isTestCommand, noticeOf, onNotice } from '../hooks/observe'
import { bodyCap, graphRows, safeHref } from '../hooks/register'

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
// The Threads tab body is [timeline, divider, table]: returns [timeline lines, table rows, divider lines].
const columns = (tree: unknown) => {
  const [graph, divider, table] = bodyOf(tree).children as unknown as R[]
  return [lines(graph), (table!.children ?? []).map(rowText), lines(divider)]
}

test('band: one status row collapsed; Threads shows the git graph and every thread in the owner\'s words', async ($, on) => {
  const m = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND())
  const row = flat(await ui.drawn())
  expect(row).toContain('now: Show tax on each cart line')
  expect(row).toContain('2/4 threads done')
  expect(row).toContain('~29%')
  expect(row).toContain('[Artifacts]')
  expect(row).not.toMatch(/\b[tsa]: |Enter|press /) // keys go to the prompt: no key labels
  await ui.press({ key: 'tab-threads' })
  const [graph, list, divider] = columns(await ui.drawn())
  expect(divider).toEqual(Array(Math.max(graph!.length, list!.length)).fill('│')) // the divider spans every row
  expect(graph![0]).toBe('[┆ ┆ earlier · 1 more]') // both open lanes; a press opens the pane with everything
  expect(graph!.at(-1)).toBe('╵ now')
  expect(graph).toContain('│ ├─● Bump Node 20 to 22 in CI  done')
  expect(graph).toContain('│ │ │ ✓ Use Node 22 in the CI workflow') // a done thread keeps its ticks
  expect(graph).toContain('├─┴─╯ ✗ tests fail: npm test: 11 pass, 1 fail') // the merge sits on the row it returns to
  expect(graph!.join('\n')).not.toContain('back to')
  for (const l of graph!.slice(1)) expect(l).toMatch(/^[│├●╵╷┆]/)
  // A table: status, title, then Tasks, Started, Last right-aligned; the prompt and what it did under the title.
  const at = (s: string) => ' '.repeat(58 - s.length)
  expect(list![0]).toBe(`4 threads${at('4 threads')}       Tasks  Started     Last`)
  expect(list).toContain(`▾ Show tax on each cart line${at('▾ Show tax on each cart line')}     ▱▱▱ 0/3  18m ago      now`)
  expect(list).toContain(`✗ Fix checkout tax rounding${at('✗ Fix checkout tax rounding')}     ▰▱▱ 1/3   2h ago  25m ago`)
  expect(list).toContain(`✓ Why is CI red?${at('✓ Why is CI red?')}${' '.repeat(12)}   1h ago   1h ago`) // no tasks: an empty Tasks cell
  expect(list).toContain('  ❯ "next, show the tax on each cart line in src/cart/CartTable.ts, formatted with…"')
  // A failure sits on its own line under what the thread did, not inside it.
  const did = list!.indexOf('  ⏺ tax.ts tax.test.ts receipt.test.ts · tests 11/12')
  expect(list![did + 1]).toBe('  ✗ receipt total off by 1 cent in receipt.test.ts')
  expect(list).toContain('  ⏺ ci.yml .nvmrc package.json · commit: Use Node 22 in CI')
  await ui.press({ key: 'more-threads' })
  expect(columns(await ui.drawn())[1]).toContain('    ● Add a tax column to CartTable') // show all: the now thread opens with its tasks
  await ui.press({ key: 'less' })
  // The right columns sit at the same offset in every title row: one first-box width, one cell length.
  const table = (bodyOf(await ui.drawn()).children[2]!.children as unknown as R[]).filter(r => r.type === 'Box' && r.children!.length === 2)
  expect(table.length).toBe(5) // the header and 4 threads
  expect(new Set(table.map(r => r.children![0]!.props!.width))).toEqual(new Set([58]))
  expect(new Set(table.map(r => cell(r.children![1]).length))).toEqual(new Set([30]))
  expect(m.calls()).toBe(0) // demo never calls the model
  await ui.unmount()
})

test('minimize leaves an icon, and pressing it brings the row back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  const ui = await $.ui.mount(BAND())
  expect(flat(await ui.drawn())).toContain('now: Show tax on each cart line')
  await ui.press({ key: 'min' })
  expect(flat(await ui.drawn()).trim()).toBe('[▴ @whatcha-doing]')
  await ui.press({ key: 'restore' })
  expect(flat(await ui.drawn())).toContain('now: Show tax on each cart line')
  await ui.unmount()
})

test('height: 30% of a tall terminal; a press on a cut end grows the band to show all, and again shows less', async ($, on) => {
  expect(bodyCap(50)).toBe(15)
  expect(bodyCap(100)).toBe(30)
  expect(bodyCap(20)).toBe(14)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(whatcha('demo'))
  await $.command.run(whatcha('threads'))
  // 12 rows: cap 6, so the timeline keeps its two ends and the 4 newest rows; the list cuts to "+N more".
  const ui = await $.ui.mount(BAND(12))
  const [graph, side] = columns(await ui.drawn())
  expect(graph!.length).toBe(6)
  expect(graph![0]).toMatch(/^\[(┆ )+earlier · \d+ more\]$/)
  expect(graph!.at(-1)).toBe('╵ now')
  expect(side!.length).toBe(6)
  expect(side!.at(-1)).toMatch(/^\[\+\d+ more\]$/)
  await ui.press({ key: 'earlier' })
  const [allGraph, allSide] = columns(await ui.drawn())
  expect([...allGraph!, ...allSide!].join('\n')).not.toContain('more')
  expect(allGraph![0]).toBe('[╷ earlier · show less]')
  expect(allGraph).toContain('● Fix checkout tax rounding  paused')
  expect(allGraph).toContain('│ ✓ Round tax per line to the cent') // the cut rows are back
  expect(flat(await ui.drawn())).toContain('[Show less]')
  await ui.press({ key: 'earlier' })
  expect(columns(await ui.drawn())[0]!.length).toBe(6) // the same row again: back to normal
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
  // A follow-up prompt shows its own words, not the title again; back-to-back test passes read as one row.
  const graph = graphRows({
    current: 1, threads: [{ id: 1, title: 'Fix the tax', state: 'done', todos: [], files: [] }],
    log: [
      { kind: 'prompt', text: 'fix the tax', thread: 1 },
      { kind: 'prompt', text: 'now run the tests', thread: 1 },
      { kind: 'test', text: 'tests pass: npm test', thread: 1 },
      { kind: 'test', text: 'tests pass: npm test', thread: 1 },
    ],
  }).map(r => r.text)
  expect(graph).toEqual(['Fix the tax', 'Now run tests', '2× tests pass: npm test'])
  expect([isTestCommand('npm test'), isTestCommand('claude plugin test .'), isTestCommand('sed -n 1p tests/tax.test.ts')]).toEqual([true, true, false])
  expect(titleOf('[Image #1] here reduce padding, its not using the full width. thanks'))
    .toBe('Here reduce padding, its not using full width')
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

  const ui = await $.ui.mount(BAND())
  await ui.press({ key: 'tab-threads' })
  const [graph, list] = columns(await ui.drawn())
  expect(graph!.filter(l => l.includes('Add dark mode option')).length).toBe(1) // the lane goes on, no second node
  expect(graph).toContain('● Add dark mode option src/settings.js  done')
  expect(graph).toContain('├─● Why CI workflow fail repo  answered')
  expect(graph).toContain('│ ├─● Bump node CI workflow 22  done')
  expect(graph).toContain('● Write short release notes 0.4.0 CHANGELOG.md  done')
  // The last prompt each thread got, as typed.
  expect(list).toContain('  ❯ "back to dark mode: run npm test and tell me what fails. Don\'t fix it yet."')
  expect(list).toContain('  ⏺ settings.js · tests 2/2')
  expect(list).toContain('  ❯ "wait, unrelated: why would the CI workflow fail on this repo? just look, short…"')

  await ui.press({ key: 'tab-summary' })
  const sent = m.sent()
  // The compact digest: one line per thread with its side-trip parent and counts, then the last test.
  expect(sent).toContain('#1 Add dark mode option src/settings.js [done] 1 files\n#2<1 Why CI workflow fail repo [answered]\n')
  expect(sent).toContain('#3<2 Bump node CI workflow 22 [done] 1 files\n#4 Write short release notes 0.4.0 CHANGEL… [done] 1 files')
  expect(sent).toContain('now #4\ntest: pass npm test: 2 pass, 0 fail')
  await ui.unmount()
})

const TAP = '> node --test\n\nTAP version 13\nok 1 - renders font size\nok 2 - snapshot\n1..2\n# tests 2\n# pass 2\n# fail 0\n'
