// Pure state changes from hooks, the demo fixture, and the Summary request.
// No model calls here: the pane's passive tabs come only from these.
import type { ArtifactRow, Observed, Summary, Thread, Todo } from '../types'

export const emptyObserved: Observed = { threads: [], current: 0, log: [] }

export const short = (s: string, n = 48) => {
  // Drop control characters: they come from tool output, and the engine refuses a Text that holds them.
  const one = s.replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const base = (p: string) => p.split('/').slice(-2).join('/')
const cur = (o: Observed) => o.threads.find(t => t.id === o.current)
const log = (o: Observed, kind: Observed['log'][number]['kind'], text: string): Observed => ({
  ...o,
  log: [...o.log, { kind, text, thread: o.current }].slice(-200),
})
const setThread = (o: Observed, id: number, fn: (t: Thread) => Thread): Observed => ({
  ...o,
  threads: o.threads.map(t => (t.id === id ? fn(t) : t)),
})
function open(o: Observed, title: string, parent?: number): Observed {
  const id = (o.threads.at(-1)?.id ?? 0) + 1
  const paused = o.threads.map(t => (t.id === o.current && t.state === 'active' ? { ...t, state: 'paused' as const } : t))
  return { ...o, current: id, threads: [...paused, { id, title: short(title), parent, state: 'active', todos: [], files: [] }] }
}
const ancestors = (o: Observed, id: number): Thread[] => {
  const t = o.threads.find(x => x.id === id)
  return t?.parent ? [...ancestors(o, t.parent), o.threads.find(x => x.id === t.parent)!].filter(Boolean) : []
}

const SKIP = new Set('a an the to in on of for and or this that it is be my me please just would could can you'.split(' '))
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(w => w && !SKIP.has(w))
/** First ~6 meaningful words of the first clause, without the cue ("wait, unrelated:"). */
export function titleOf(text: string): string {
  const w = text.replace(CUE, '').split(/[:?!\n]|\.\s/)[0]!.split(/\s+/).filter(x => x && !SKIP.has(x.toLowerCase()))
  const t = w.slice(0, 6).join(' ')
  return t ? t[0]!.toUpperCase() + t.slice(1) : short(text)
}
const CUE = /^\s*((ok(ay)?|so)[,\s]+)?((wait|btw|by the way|side question|quick question|unrelated|new thing|also|next|back to [^:,.]*|go(ing)? back( to [^:,.]*)?)\b[,:\s-]*)*/i
const TANGENT = /^\s*(wait|btw|by the way|side question|quick question)\b|\bunrelated\b/i
const RETURN = /^\s*((ok(ay)?|so)[,\s]+)?(back to|go(ing)? back)\b/i
const NEW = /^\s*((ok(ay)?|so)[,\s]+)?(new thing|new task|also|next)\b/i
const OK = /^\s*(ok(ay)?|sure|yes|yep|great|cool)\b/i

/**
 * Every prompt lands somewhere, from cheap word cues:
 * "back to X" returns to the thread with most shared words, "wait/btw/unrelated" opens a tangent,
 * "new thing/also/next" opens a top-level thread, "ok <verb>" after a tangent nests under it,
 * anything else is a step of the current thread.
 */
export function onPrompt(o: Observed, text: string): Observed {
  const now = cur(o)
  if (!now || NEW.test(text)) o = open(o, titleOf(text))
  else if (RETURN.test(text)) {
    const want = new Set(words(text.split(/[:,]|\.\s/)[0]!))
    const score = (t: Thread) => words(t.title).filter(w => want.has(w)).length
    const best = o.threads.filter(t => t.id !== now.id).sort((a, b) => score(b) - score(a))[0]
    const back = best && score(best) > 0 ? best : ancestors(o, now.id).at(-1)
    if (back) {
      o = setThread(o, now.id, t => (t.state === 'active' ? { ...t, state: 'paused' } : t))
      o = setThread({ ...o, current: back.id }, back.id, t => ({ ...t, state: 'active' }))
      o = log(o, 'return', `back to ${back.title}`)
    } else o = open(o, titleOf(text))
  } else if (TANGENT.test(text)) o = open(o, titleOf(text), now.id)
  else if (OK.test(text) && now.parent) o = open(o, titleOf(text), now.id)
  else o = setThread(o, now.id, t => ({ ...t, state: 'active' }))
  o = setThread(o, o.current, t => ({ ...t, prompt: text.trim().slice(0, 300) }))
  return log(o, 'prompt', short(text, 80))
}

/** Marks the current thread as seen at `at`: the first time sets its start. */
export const stamp = (o: Observed, at: number): Observed =>
  setThread(o, o.current, t => ({ ...t, startedAt: t.startedAt ?? at, lastAt: at }))

/** The first ~n chars on one line, cut at a word, so a prompt reads as the owner typed it. */
export function snippet(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()
  if (one.length <= n) return one
  const cut = one.slice(0, n)
  return (cut.lastIndexOf(' ') > n / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,.;:]+$/, '') + '…'
}

/** A publish of `url` at `at`: a new one is created then, a known one is modified then. */
export function onArtifact(rows: ArtifactRow[], url: string, title: string, at: number): ArtifactRow[] {
  const was = rows.find(r => r.url === url)
  const row = { url, title: title || was?.title || url, created: was?.created ?? at, modified: at }
  return [row, ...rows.filter(r => r.url !== url)].sort((a, b) => b.modified - a.modified)
}

/**
 * At the end of a main-loop answer: the current thread is done (it changed or tested something)
 * or answered (read only), unless an error came after its last prompt or a todo is still open.
 */
export function onTurnEnd(o: Observed, isAnswered: boolean): Observed {
  const now = cur(o)
  if (!now || !isAnswered) return o
  const since = o.log.slice(o.log.findLastIndex(a => a.kind === 'prompt' || a.kind === 'return') + 1)
  const isOpen = since.some(a => a.kind === 'error' || (a.kind === 'test' && a.text.startsWith('tests fail'))) ||
    now.todos.some(t => t.status !== 'completed')
  if (isOpen) return o
  const did = now.files.length > 0 || o.log.some(a => a.thread === now.id && a.kind === 'test')
  return setThread(o, now.id, t => ({ ...t, state: did ? 'done' : 'answered' }))
}

export function onEdit(o: Observed, path: string): Observed {
  if (!cur(o)) o = open(o, `Edit ${base(path)}`)
  if (!cur(o)!.files.includes(path)) o = setThread(o, o.current, t => ({ ...t, files: [...t.files, path] }))
  return log(o, 'edit', base(path))
}

/** A TodoWrite list that shares no item with the current one is a new task set. */
export function onTodos(o: Observed, todos: Todo[]): Observed {
  const now = cur(o)
  const isNewSet = !!now && now.todos.length > 0 && !todos.some(n => now.todos.some(t => t.text === n.text))
  if (!now) o = open(o, todos[0]?.text ?? 'Tasks')
  else if (isNewSet) {
    o = setThread(o, now.id, t => ({ ...t, state: t.todos.every(x => x.status === 'completed') ? 'done' : 'paused' }))
    o = open(o, todos[0]?.text ?? 'Tasks')
  }
  o = setThread(o, o.current, t => ({ ...t, todos }))
  return log(o, 'todo', `${todos.filter(t => t.status === 'completed').length}/${todos.length} todos done`)
}

/** Pass and fail counts from common runners (node --test, jest, vitest, pytest); else the exit code decides. */
export function testResult(cmd: string, out: string, isError: boolean) {
  const n = (re: RegExp) => { const m = out.match(re); return m ? Number(m[1] ?? m[2]) : undefined }
  const pass = n(/#\s*pass\s+(\d+)|(\d+)\s+pass(?:ed|ing)?\b/i)
  const fail = n(/#\s*fail\s+(\d+)|(\d+)\s+fail(?:ed|ing|ures?)?\b/i)
  // `npm test | head` exits 0 even when tests fail, so a parsed fail count wins over the exit code.
  const ok = fail !== undefined ? fail === 0 : !isError
  const counts = pass !== undefined || fail !== undefined ? `${pass ?? 0} pass, ${fail ?? 0} fail` : ''
  return { ok, text: [cmd.split(/\||2>&1/)[0]!.trim(), counts].filter(Boolean).join(': ') }
}

/** A failed test run marks the current thread's running todo as blocked. */
export function onTest(o: Observed, ok: boolean, text: string): Observed {
  o = { ...log(o, 'test', `${ok ? 'tests pass' : 'tests fail'}: ${short(text, 60)}`), lastTest: { ok, text: short(text, 80) } }
  return ok ? o : setThread(o, o.current, t => ({ ...t, todos: t.todos.map(x => (x.status === 'in_progress' ? { ...x, status: 'blocked' } : x)) }))
}

export const onError = (o: Observed, tool: string, text: string) => log(o, 'error', `${tool}: ${short(text.split('\n')[0] ?? '', 70)}`)
export const onAgent = (o: Observed, what: string) => log(o, 'agent', `helper: ${short(what, 60)}`)
/** `git commit -m "msg"`: the message, else the command. */
export const onCommit = (o: Observed, cmd: string) => log(o, 'commit', `commit: ${short(cmd.match(/-m\s+(["'])(.*?)\1/)?.[2] ?? cmd, 60)}`)
export const isTestCommand = (cmd: string) => /\b(test|jest|vitest|pytest|cargo test|go test|tsc|lint)\b/.test(cmd)

/** The owner's budget per Haiku call (spec): input and output tokens. */
export const SUMMARY_IN = 600
export const SUMMARY_OUT = 250
const TODO_WORD: Record<string, string> = { completed: 'done', in_progress: 'doing', pending: 'todo', blocked: 'stuck' }

/**
 * A compact digest: one line per thread (id, title, state, counts), its todos
 * (at most 10 in all, newest threads first), and only the last test and error.
 */
export function summaryInput(o: Observed): string {
  let room = 10
  const blocks = [...o.threads].reverse().map(t => {
    const commits = o.log.filter(a => a.thread === t.id && a.kind === 'commit').length
    const counts = [t.files.length && `${t.files.length} files`, commits && `${commits} commits`].filter(Boolean).join(', ')
    const head = `#${t.id}${t.parent ? `<${t.parent}` : ''} ${short(t.title, 40)} [${t.state}]${counts ? ` ${counts}` : ''}`
    const todos = t.todos.slice(0, Math.max(0, room)).map(d => ` ${TODO_WORD[d.status] ?? d.status}: ${short(d.text, 40)}`)
    room -= todos.length
    return [head, ...todos]
  })
  const lines = blocks.reverse().flat()
  lines.push(`now #${o.current}`)
  if (o.lastTest) lines.push(`test: ${o.lastTest.ok ? 'pass' : 'fail'} ${short(o.lastTest.text, 40)}`)
  const err = o.log.findLast(a => a.kind === 'error')
  if (err) lines.push(`error: ${short(err.text, 60)}`)
  // A long session drops its oldest lines: 1800 chars plus the ~460 of the prompt stays under 600 tokens.
  while (lines.join('\n').length > 1800 && lines.length > 1) lines.shift()
  return lines.join('\n')
}

export const SUMMARY_SYSTEM = 'Summarize a coding session in very simple English. JSON only.'
export const summaryPrompt = (input: string) =>
  `Threads (#id<parent = side trip; done/answered are finished):\n${input}\n\n` +
  'Reply JSON only. p: percent done. t: max 8 tasks as [name 2-4 words, status d=done a=active b=stuck r=left, ' +
  'plain line of at most 8 words]. b: why stuck, at most 12 words.\n' +
  '{"p":0,"t":[["","d",""]],"b":[""]}'

const STATUS: Record<string, Summary['tasks'][number]['status']> = { d: 'completed', a: 'active', b: 'blocked', r: 'remaining' }
/** Parses the short JSON (tasks as [name, status, line]) and checks it; throws a plain message when it does not fit. */
export function parseSummary(text: string): Summary {
  const v = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { p: number; t: string[][]; b: string[] }
  const ok =
    typeof v.p === 'number' && Array.isArray(v.t) && Array.isArray(v.b) &&
    v.t.every(t => Array.isArray(t) && typeof t[0] === 'string' && (t[1] ?? '') in STATUS)
  if (!ok) throw new Error('The summary came back in the wrong shape.')
  const tasks = v.t.map(([n, s, e]) => ({ name: n!, status: STATUS[s!]!, eli5: e ?? '' }))
  return {
    percent: Math.max(0, Math.min(100, Math.round(v.p))),
    tasks,
    blockers: v.b,
    // Work left is the left tasks by name: asking for it again would repeat text.
    remaining: tasks.filter(t => t.status === 'remaining').map(t => t.name),
  }
}

export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const S = 'src/settings/'
const MIN = 60_000
/** The sample session, its times counted back from `now`. */
export const demoObserved = (now: number): Observed => ({
  current: 4,
  threads: [
    {
      id: 1, title: 'Add dark mode to Settings', state: 'paused',
      prompt: 'add dark mode to Settings: a theme toggle, and move the hard-coded colors in Settings.tsx to theme tokens',
      startedAt: now - 130 * MIN, lastAt: now - 25 * MIN,
      todos: [
        { text: 'Add a theme toggle to Settings', status: 'completed' },
        { text: 'Move colors to theme tokens', status: 'in_progress' },
        { text: 'Update the Settings snapshot', status: 'blocked' },
      ],
      files: [`${S}Settings.tsx`, 'src/theme/tokens.ts', `${S}Settings.test.tsx`],
    },
    {
      id: 2, title: 'Why is CI red?', parent: 1, state: 'answered', todos: [], files: [],
      prompt: 'wait, why is CI red on main since this morning? just look, short answer',
      startedAt: now - 110 * MIN, lastAt: now - 100 * MIN,
    },
    {
      id: 3, title: 'Bump Node 20 to 22 in CI', parent: 2, state: 'done',
      prompt: 'ok bump Node 20 to 22 in the CI workflow and .nvmrc, then commit',
      startedAt: now - 95 * MIN, lastAt: now - 80 * MIN,
      todos: [{ text: 'Use Node 22 in the CI workflow', status: 'completed' }],
      files: ['.github/workflows/ci.yml', '.nvmrc', 'package.json'],
    },
    {
      id: 4, title: 'Write release notes', state: 'active',
      prompt: 'ok, now write the release notes for v2.4 in CHANGELOG.md from the PRs merged since v2.3, grouped by feature and fix',
      startedAt: now - 18 * MIN, lastAt: now - 2 * MIN,
      todos: [
        { text: 'Collect merged PRs since v2.3', status: 'in_progress' },
        { text: 'Draft the notes', status: 'pending' },
        { text: 'Ask for a review', status: 'pending' },
      ],
      files: ['CHANGELOG.md'],
    },
  ],
  log: [
    { kind: 'prompt', text: 'add dark mode to Settings', thread: 1 },
    { kind: 'todo', text: '0/3 todos done', thread: 1 },
    { kind: 'edit', text: 'settings/Settings.tsx', thread: 1 },
    { kind: 'edit', text: 'theme/tokens.ts', thread: 1 },
    { kind: 'prompt', text: 'why is CI red?', thread: 2 },
    { kind: 'agent', text: 'helper: read the CI logs', thread: 2 },
    { kind: 'prompt', text: 'bump Node 20 to 22 in CI', thread: 3 },
    { kind: 'edit', text: 'workflows/ci.yml', thread: 3 },
    { kind: 'edit', text: '.nvmrc', thread: 3 },
    { kind: 'commit', text: 'commit: Use Node 22 in CI', thread: 3 },
    { kind: 'return', text: 'back to Add dark mode to Settings', thread: 1 },
    { kind: 'edit', text: 'settings/Settings.test.tsx', thread: 1 },
    { kind: 'test', text: 'tests fail: npm test: 41 pass, 1 fail', thread: 1 },
    { kind: 'error', text: 'Bash: 1 snapshot failed in Settings.test.tsx', thread: 1 },
    { kind: 'prompt', text: 'ok, now write the release notes', thread: 4 },
    { kind: 'todo', text: '0/3 todos done', thread: 4 },
    { kind: 'edit', text: 'CHANGELOG.md', thread: 4 },
  ],
  lastTest: { ok: false, text: 'npm test: 41 pass, 1 fail' },
})

const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Sample Artifacts this project published, spread over days. */
export const demoArtifacts = (now: number): ArtifactRow[] =>
  [
    { title: 'band look', created: now - 2 * DAY, modified: now - 3 * HOUR, url: 'https://claude.ai/code/artifact/4f1c2b7e-band-look' },
    { title: 'release notes v2.4 draft', created: now - 40 * MIN, modified: now - 6 * MIN, url: 'https://claude.ai/code/artifact/9a3e51d0-release-notes' },
    { title: 'load test report', created: now - 5 * DAY, modified: now - 1 * DAY, url: 'https://claude.ai/code/artifact/c27d8e44-load-test-report' },
    { title: 'security audit', created: now - 9 * DAY, modified: now - 9 * DAY, url: 'https://claude.ai/code/artifact/e80b13fa-security-audit' },
    { title: 'Settings dark mode options', created: now - 26 * HOUR, modified: now - 20 * HOUR, url: 'https://claude.ai/code/artifact/71d0c9b2-dark-mode' },
  ].sort((a, b) => b.modified - a.modified)

/** Haiku's real reply (claude-haiku-5-5, 2026-11-24) to summaryPrompt(summaryInput(demoObserved)): 223 output tokens. */
export const DEMO_REPLY =
  '{"p":38,"t":[["Theme toggle in Settings","d","Added a theme toggle to Settings."],["Move colors to tokens","a","Moving colors to theme tokens."],' +
  '["Update Settings snapshot","b","Snapshot fails after the change."],["Explain red CI","d","Answered why CI was red."],' +
  '["Node 22 in CI","d","CI workflow now uses Node 22."],["Collect merged PRs","a","Gathering merged PRs since v2.3."],' +
  '["Draft the notes","r","Write the release notes draft."],["Ask for review","r","Request review of the notes."]],' +
  '"b":["Snapshot test fails after the theme change."]}'
export const demoSummary: Summary = parseSummary(DEMO_REPLY)
