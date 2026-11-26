// Pure state changes from hooks, the demo fixture, and the Summary request.
// No model calls here: the pane's passive tabs come only from these.
import type { ArtifactRow, Observed, PlanStep, Summary, SummaryTask, Thread, Todo } from '../types'

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
  return { ...o, current: id, threads: [...paused, { id, title: short(title, 200), parent, state: 'active', todos: [], files: [] }] }
}
const ancestors = (o: Observed, id: number): Thread[] => {
  const t = o.threads.find(x => x.id === id)
  return t?.parent ? [...ancestors(o, t.parent), o.threads.find(x => x.id === t.parent)!].filter(Boolean) : []
}

/** Text the engine sends as a user turn (a background task's report, a reminder, a local command's echo), not a person's prompt. */
export const isEngineText = (text: string) =>
  /^\s*(<(task-notification|system-reminder|local-command-[a-z]+|command-(name|message|args)|bash-(input|stdout|stderr))\b|This session is being continued from a previous conversation)/.test(text)

/** A background task's report in plain words, from its <summary> tag: `Agent "Cover page" finished`. */
export function noticeOf(text: string): string | undefined {
  if (!/^\s*<task-notification\b/.test(text)) return
  return /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() || 'A background task finished'
}

/** A background task's report is a step of the current thread, never a prompt. */
export function onNotice(o: Observed, text: string): Observed {
  return log(cur(o) ? o : open(o, text), 'agent', short(text, 80))
}

/**
 * Repairs state saved before 1.0.9: task reports saved as prompts become plain report steps, other engine
 * prompts go, threads named after them take their first real prompt, and reads like `sed … tests/x.test.ts` stop
 * counting as test runs.
 */
export function dropEngineText(o: Observed): Observed {
  const log = o.log
    .filter(a => !(a.kind === 'prompt' && isEngineText(a.text) && !noticeOf(a.text)))
    .filter(a => !(a.kind === 'test' && /^tests (pass|fail): (sed|grep|rg|git|cat|ls|head|tail)\b/.test(a.text)))
    .map(a => (a.kind === 'prompt' && noticeOf(a.text) ? { ...a, kind: 'agent' as const, text: noticeOf(a.text)! } : a))
  const threads = o.threads.map(t => {
    // The compaction summary is engine text too: its thread keeps its work and takes the next real prompt's name.
    const summary = /session (is )?being continued from (a )?previous conversation/i.test(`${t.title} ${t.first ?? ''}`)
    if (!isEngineText(t.title) && !summary) return t
    const p = log.find(a => a.kind === 'prompt' && a.thread === t.id)
    return { ...t, first: p?.text, name: summary ? undefined : t.name, title: p ? short(titleOf(p.text), 200) : summary ? 'Earlier work' : 'Background tasks' }
  })
  return { ...o, log, threads }
}

const SKIP = new Set('a an the to in on of for and or this that it is be my me please just would could can you'.split(' '))
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(w => w && !SKIP.has(w))
/** First ~6 meaningful words of the first clause, without the cue ("wait, unrelated:"). */
export function titleOf(text: string): string {
  // Pasted images and text are noise in a title; the row cuts at the real width, so keep the whole first clause.
  const plain = untag(text).replace(LIST, '').replace(CUE, '')
  const clauses = plain.split(/[:?!\n]|\.\s/).map(c => c.split(/\s+/).filter(x => x && !SKIP.has(x.toLowerCase())))
  // "Where are these" names nothing: take the first clause that is not a fragment, else the first one.
  const w = clauses.find(c => !isFragment(c)) ?? clauses.find(c => c.length) ?? []
  const t = w.slice(0, 24).join(' ')
  return t ? t[0]!.toUpperCase() + t.slice(1) : short(plain, 200)
}
/** One word, or ending on a word that points elsewhere ("these", "it", "where"): not a name on its own. */
// Also a clause cut mid-way: it ends on "its", "the", "to", "and".
const DANGLING = new Set('these this those that it them they there here what which where why how something stuff its his her their our my your the a an to of and or but with for in on at by'.split(' '))
const isFragment = (w: string[]) => w.length < 2 || DANGLING.has(w.at(-1)!.toLowerCase().replace(/[^a-z]/g, ''))
// Words too common to tell two topics apart.
const COMMON = new Set('are is was were do does did i we so also now then with from into make use what where why how which these those there here stuff thing things basically like should will need want get let'.split(' '))
const topicWords = (s: string) => words(s).filter(w => w.length > 2 && !COMMON.has(w))
// A prompt typed as a list item or quote ("- Prompt reference: ...") keeps its words, not the "- ".
const LIST = /^\s*((?:[-*+>]|\d+[.)]|\[[ xX]?\])\s+)+/
export const unlist = (s: string) => s.replace(LIST, '')
/** Drops the composer's attachment tags: "[Image #1]", "[Pasted text #2 +40 lines]", "[File #3]". */
// Engine wrappers like <pasted_content id="384e"> go; the text inside stays.
export const untag = (s: string) => s.replace(/\[[A-Z][\w ]* #\d+[^\]]*\]|<\/?[a-z][\w-]*(\s[^<>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim()
/** A prompt as a sub row shows it: no tags, no list mark, one line. */
export const promptLine = (s: string) => {
  // Links and absolute paths are noise in a row ("/Users/x/Pictures bruh" reads "Bruh"); so are "wait," and "new thing:".
  const t = unlist(untag(s).replace(/(^|\s)(https?:\/\/|~\/|\.{0,2}\/)\S*/g, ' ').replace(/\s+/g, ' ').trim()).replace(CUE, '').trim()
  return t && t[0]!.toUpperCase() + t.slice(1)
}
const CUE = /^\s*((ok(ay)?|so|um|uh)[,\s]+)*((wait|btw|by the way|side question|quick question|unrelated|new thing|also|next|back to [^:,.]*|go(ing)? back( to [^:,.]*)?)\b[,:\s-]*)*/i
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
  else if (isNewTopic(o, now, text)) o = open(o, titleOf(text))
  else o = setThread(o, now.id, t => ({ ...t, state: 'active' }))
  o = setThread(o, o.current, t => ({ ...t, first: t.first ?? short(text, 300), prompt: text.trim().slice(0, 300) }))
  // 300: a prompt row shows up to 2 lines of a wide band.
  return log(o, 'prompt', short(text, 300))
}

/**
 * A long prompt (8+ topic words) that shares no topic word with the thread's name or its prompts is a new topic.
 * shortcut: word overlap only, so a long follow-up in new words opens a thread; use the on-device model if it misfires.
 */
function isNewTopic(o: Observed, now: Thread, text: string): boolean {
  const mine = topicWords(text)
  // Picks pasted from an options page ("- Exact: 1 Yellow on blue tile", one per line) answer this thread.
  if (mine.length < 8 || text.trim().split('\n').every(l => /^\s*[-*] [^:\n]{1,40}:/.test(l))) return false
  const seen = new Set(topicWords([now.title, now.name ?? '', now.prompt ?? '', ...o.log.filter(a => a.thread === now.id && a.kind === 'prompt').map(a => a.text)].join(' ')))
  return !mine.some(w => seen.has(w))
}

/** Marks the current thread as seen at `at`: the first time sets its start; `sent` marks a prompt the owner sent. */
export const stamp = (o: Observed, at: number, sent = false): Observed => {
  // The newest log entry is what this event added: it takes the time, for the sub rows' "· 12:07".
  const last = o.log.at(-1)
  if (last && last.at === undefined) o = { ...o, log: [...o.log.slice(0, -1), { ...last, at }] }
  return setThread(o, o.current, t => ({ ...t, startedAt: t.startedAt ?? at, lastAt: at, sentAt: sent ? at : t.sentAt }))
}

/** One prompt the owner typed, as the transcript file stamps it. */
export type PromptTime = { text: string; at: number }
/** The transcript file's times: each typed prompt's, and when each tool call's result came back, by its id. */
export type Times = { prompts: PromptTime[]; tools: Record<string, number> }
/** A prompt's match key: its first 60 chars, spaces collapsed (transcript times, chat rows). */
export const key = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)

/** The `timestamp` of each prompt and tool result in a transcript .jsonl (any tail of it; a cut first line is skipped). */
export function transcriptTimes(jsonl: string): Times {
  const out: Times = { prompts: [], tools: {} }
  for (const line of jsonl.split('\n')) {
    let j: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } }
    try { j = JSON.parse(line) } catch { continue }
    const at = Date.parse(j.timestamp ?? '')
    if (Number.isNaN(at) || j.type !== 'user' || j.isMeta) continue
    const c = j.message?.content
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? (c as { type?: string; text?: string; tool_use_id?: string }[]) : []
    const results = blocks.filter(b => b.type === 'tool_result')
    for (const b of results) if (b.tool_use_id) out.tools[b.tool_use_id] = at
    if (results.length) continue
    const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
    if (text.trim()) out.prompts.push({ text: key(text), at })
  }
  return out
}

/** The time entry for a prompt `text`, searched from `from` on; its index, or -1. */
export const timeOf = (times: PromptTime[], text: string, from: number) => times.findIndex((p, i) => i >= from && p.text === key(text))

/** "sent 10:42": the local clock time of the thread's last prompt. */
export const sentLabel = (at: number) => {
  const d = new Date(at)
  return `sent ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

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
 * or answered (read only), unless its last test run since its last prompt failed or a todo is still open.
 * The reply clears the thread's earlier errors: Claude saw them and answered anyway.
 */
export function onTurnEnd(o: Observed, isAnswered: boolean): Observed {
  const now = cur(o)
  if (!now || !isAnswered) return o
  o = clearErrors(o)
  const since = o.log.slice(o.log.findLastIndex(a => a.kind === 'prompt' || a.kind === 'return') + 1)
  const isOpen = !!since.findLast(a => a.kind === 'test')?.text.startsWith('tests fail') || now.todos.some(t => t.status !== 'completed')
  if (isOpen) return o
  const did = now.files.length > 0 || o.log.some(a => a.thread === now.id && a.kind === 'test')
  return setThread(o, now.id, t => ({ ...t, state: did ? 'done' : 'answered' }))
}

export function onEdit(o: Observed, path: string): Observed {
  // A thread opened by an edit is named in words, never by the file.
  if (!cur(o)) o = open(o, 'Edited files')
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
  // Only the test run of a chain: "sed -n 4p x; tsc -p . && npm test" reads as "npm test" (the last test run, so "tsc && npm test" names npm test).
  const run = cmd.split(/;|&&|\|\||\|/).map(s => s.replace(/\s*2>&1\s*/g, ' ').trim()).filter(isTestCommand).at(-1) ?? cmd.trim()
  return { ok, text: [run, counts].filter(Boolean).join(': '), isCounted: !!counts }
}

/** A failed test run marks the current thread's running todo as blocked; a passing one unblocks it. */
export function onTest(o: Observed, ok: boolean, text: string): Observed {
  o = { ...log(o, 'test', `${ok ? 'tests pass' : 'tests fail'}: ${short(text, 200)}`), lastTest: { ok, text: short(text, 80) } }
  const [from, to] = ok ? ['blocked', 'in_progress'] as const : ['in_progress', 'blocked'] as const
  return setThread(o, o.current, t => ({ ...t, todos: t.todos.map(x => (x.status === from ? { ...x, status: to } : x)) }))
}

export const onError = (o: Observed, tool: string, text: string) => log(o, 'error', `${tool}: ${short(text.split('\n')[0] ?? '', 70)}`)
/** A later step that worked, or a reply, clears the current thread's errors: a thread is stuck only on its last result. */
export const clearErrors = (o: Observed): Observed =>
  o.log.some(a => a.kind === 'error' && a.thread === o.current) ? { ...o, log: o.log.filter(a => !(a.kind === 'error' && a.thread === o.current)) } : o
// Commands whose exit 1 means "no match" or "not equal", not a failure.
const QUIET = new Set(['grep', 'egrep', 'fgrep', 'rg', 'test', '[', '[[', 'diff', 'cmp'])
/**
 * `git log | grep -ci x` printing 0, `test -f x`, `diff a b`: the pipeline's last command is one of QUIET and it
 * exited 1 with nothing that reads as an error (Bash gives stdout and stderr as one text).
 */
export function isQuietExit(cmd: string, text: string): boolean {
  const last = cmd.split(/\|\||&&|;|\||\n/).map(s => s.trim()).filter(Boolean).at(-1)?.split(/\s+/)[0]?.replace(/^.*\//, '') ?? ''
  const [code, ...out] = text.split('\n')
  return code?.trim() === 'Exit code 1' && QUIET.has(last) && !/error|no such file|not found|denied|fatal|usage:|invalid|unrecognized/i.test(out.join('\n'))
}
export const onAgent = (o: Observed, what: string) => log(o, 'agent', `helper: ${short(what, 200)}`)
/** The commit message's first line (a heredoc's, else `-m "msg"`'s), never the command: `commit: msg`, or `commit`. */
export function onCommit(o: Observed, cmd: string): Observed {
  const msg = cmd.match(/<<-?\s*['"]?\w+['"]?[^\n]*\n\s*([^\n]+)/)?.[1] ?? cmd.match(/-m\s+(["'])(.*?)\1/)?.[2]
  return log(o, 'commit', msg && !msg.startsWith('$(') ? `commit: ${short(msg, 200)}` : 'commit')
}
// The tool word must stand alone as a command word, so a path such as tests/tax.test.ts is not a test run.
// `test` counts only as another tool's argument (npm test, claude plugin test .), never the shell's own `test -f x`.
export const isTestCommand = (cmd: string) =>
  /(^|[\s;&|(])(jest|vitest|pytest|tsc|lint|eslint)(?=$|[\s;&|)])/.test(cmd) ||
  /(^|[\s;&|(])(?!(if|then|elif|while|until|do|!)\s)[^\s;&|(]+\s+test(?=$|[\s;&|)])/.test(cmd)

const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\[[ xX]\]\s+/, '').replace(/\s+/g, ' ').trim()
/**
 * A plan's steps from its markdown: numbered and bulleted items at their nesting depth, and section headings.
 * A wrapped item's next lines join it; prose, code blocks and headings with no items under them drop.
 */
export function planSteps(md: string): PlanStep[] {
  const out: PlanStep[] = []
  const indents: number[] = []
  let inCode = false
  let isOpen = false // the last item may take continuation lines
  let wasBlank = false
  for (const line of md.replace(/\t/g, '    ').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; isOpen = false; continue }
    if (inCode) continue
    if (!line.trim()) { wasBlank = true; continue }
    const h = /^\s*#{1,6}\s+(.+)/.exec(line)
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.+)/.exec(line)
    if (h) {
      out.push({ text: plain(h[1]!), depth: 0, mark: '#' })
      indents.length = 0
      isOpen = false
    } else if (li) {
      const ind = li[1]!.length
      while (indents.length && indents.at(-1)! > ind) indents.pop()
      if (!indents.length || indents.at(-1)! < ind) indents.push(ind)
      out.push({ text: plain(li[3]!), depth: indents.length - 1, mark: /\d/.test(li[2]!) ? li[2]!.replace(')', '.') : '·' })
      isOpen = true
    } else if (isOpen && (!wasBlank || /^\s{2,}/.test(line))) out.at(-1)!.text += ' ' + plain(line)
    else isOpen = false
    wasBlank = false
  }
  // A heading with no item under it (Context, Notes) says nothing about the steps.
  return out.filter((s, i) => s.mark !== '#' || (out[i + 1] !== undefined && out[i + 1]!.mark !== '#'))
}

/** Claude's plan (ExitPlanMode) goes on the current thread, replacing an older one. */
export function onPlan(o: Observed, md: string): Observed {
  const plan = planSteps(md)
  if (!plan.some(s => s.mark !== '#')) return o
  if (!cur(o)) o = open(o, plan.find(s => s.mark !== '#')!.text)
  return setThread(o, o.current, t => ({ ...t, plan }))
}

/** The on-device model's thread name, kept to its first line and 6 words; undefined when it is not a name. */
export const NAME_SYSTEM = 'Name the coding task in the message in 3 to 6 plain words. Reply with the name only, no quotes.'
export function threadName(reply: string | undefined): string | undefined {
  const w = untag((reply ?? '').split('\n')[0]!).replace(/^(name|title):\s*/i, '').replace(/["'“”‘’*_`.]/g, '').trim().split(/\s+/).filter(Boolean)
  // Never cut a reply to 6 words: a cut echo of the prompt ("here reduce padding, its") is a fragment, not a name.
  if (w.length < 3 || w.length > 6 || isFragment(w)) return undefined
  const s = short(w.join(' '))
  return s[0]!.toUpperCase() + s.slice(1)
}

export const SUM_SYSTEM = 'Give the gist of the request in the message in 4 to 8 plain words, like a commit subject (Fix realtime band updates). Reply with the words only, no quotes.'
/** The S row's gist, and the retry when the first gist came back too long (a long dictated prompt often gets 12+ words). */
export const BRIEF_SYSTEM = 'Give the gist of the request in the message in 3 to 5 plain words, like a short commit subject (Fix band redraw). Reply with the words only, no quotes.'
/** A prompt shorter than this (about 7 words) is its own gist: no model run. */
export const SUM_MIN = 40
/** Whether the model still owes this prompt its gist: long enough, and no answer yet ('' is a failed one). */
export const isPending = (a: { text: string; gist?: string }) => a.gist === undefined && [...promptLine(a.text)].length >= SUM_MIN
/**
 * The model's gist of `prompt` in 3 to `most` words, or undefined: shorter or longer (never cut), ending on a
 * dangling word, or an echo of the prompt's own opening words.
 */
export function promptSum(reply: string | undefined, prompt: string, most = 9): string | undefined {
  const s = untag((reply ?? '').split('\n')[0]!).replace(/^(gist|summary|subject):\s*/i, '').replace(/["“”*_`]/g, '').replace(/\.$/, '').trim()
  const w = s.split(/\s+/).filter(Boolean)
  if (w.length < 3 || w.length > most || isFragment(w)) return undefined
  const echo = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  if (echo(promptLine(prompt)).startsWith(echo(s))) return undefined
  return s[0]!.toUpperCase() + s.slice(1)
}
/**
 * Caches the gist ('' when the model gave none) and the S row's brief on every log entry of this prompt, and on the
 * thread it opened. `failed`: the model never answered, so the next session asks again.
 */
export const setSum = (o: Observed, text: string, gist: string, brief?: string, failed?: boolean): Observed => ({
  ...o,
  log: o.log.map(a => (a.kind === 'prompt' && a.text === text ? { ...a, gist, ...(brief ? { brief } : {}), failed: failed || undefined } : a)),
  threads: o.threads.map(t => (t.first === text ? { ...t, gist } : t)),
})

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
    const todos = t.todos.slice(0, Math.max(0, room)).map((d, i) => ` #${t.id}.${i + 1} ${TODO_WORD[d.status] ?? d.status}: ${short(d.text, 40)}`)
    room -= todos.length
    return [head, ...todos]
  })
  const lines = blocks.reverse().flat()
  lines.push(`now #${o.current}`)
  // Only the current thread's last run: an old failure elsewhere is no reason to call anything stuck.
  const test = o.log.findLast(a => a.kind === 'test' && a.thread === o.current)
  if (test) lines.push(`test: ${test.text.startsWith('tests pass') ? 'pass' : 'fail'} ${short(test.text.replace(/^tests (pass|fail): /, ''), 40)}`)
  const err = o.log.findLast(a => a.kind === 'error' && a.thread === o.current)
  if (err) lines.push(`error: ${short(err.text, 60)}`)
  // A long session drops its oldest lines: 1800 chars plus the ~460 of the prompt stays under 600 tokens.
  while (lines.join('\n').length > 1800 && lines.length > 1) lines.shift()
  return lines.join('\n')
}

export const SUMMARY_SYSTEM = 'Summarize a coding session in very simple English. JSON only.'
export const summaryPrompt = (input: string) =>
  `Threads (#id<parent = side trip; done/answered are finished):\n${input}\n\n` +
  'Reply JSON only. p: percent done. t: max 8 tasks as [name 2-4 words, status r=left a=active b=stuck d=done, ' +
  'plain line of at most 8 words, the #id it comes from]. b: why stuck, at most 12 words.\n' +
  '{"p":0,"t":[["","d","","#1.1"]],"b":[""]}'

const STATUS: Record<string, Summary['tasks'][number]['status']> = { d: 'completed', a: 'active', b: 'blocked', r: 'remaining' }
/** Parses the short JSON (tasks as [name, status, line]) and checks it; throws a plain message when it does not fit. */
export function parseSummary(text: string): Summary {
  const v = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { p: number; t: string[][]; b: string[] }
  const ok =
    typeof v.p === 'number' && Array.isArray(v.t) && Array.isArray(v.b) &&
    v.t.every(t => Array.isArray(t) && typeof t[0] === 'string' && (t[1] ?? '') in STATUS)
  if (!ok) throw new Error('The summary came back in the wrong shape.')
  const tasks = v.t.map(([n, s, e, r]) => ({ name: n!, status: STATUS[s!]!, eli5: e ?? '', ...(typeof r === 'string' && /^#\d/.test(r) ? { ref: r } : {}) }))
  return {
    percent: Math.max(0, Math.min(100, Math.round(v.p))),
    tasks,
    // Haiku fills "why" even with nothing stuck ("", "None"); a reason means nothing without a stuck task.
    blockers: tasks.some(t => t.status === 'blocked') ? v.b.filter(b => typeof b === 'string' && b.trim() && !/^(none|n\/a|nothing)\.?$/i.test(b.trim())) : [],
    // Work left is the left tasks by name: asking for it again would repeat text.
    remaining: tasks.filter(t => t.status === 'remaining').map(t => t.name),
  }
}

export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const MIN = 60_000
/** The demo's plan as Claude writes one: a title, prose, numbered steps with nested bullets, a wrapped step. */
export const DEMO_PLAN = `# Show tax per cart line

## Context
The cart shows one tax total; the owner wants it per line.

## Steps
1. Add a Tax column to \`CartTable.ts\`
   - read the rate from the line item
2. Format it with \`formatMoney\`, the same
   way Price is formatted
3. Add a cart table test

## Verification
- \`npm test\` passes`
/** The sample session, its times counted back from `now`. */
export const demoObserved = (now: number): Observed => ({
  current: 4,
  threads: [
    {
      id: 1, title: 'Fix checkout tax rounding', state: 'paused',
      prompt: 'the tax on a $10 mug shows $0.82, it should be $0.83. fix the rounding in src/checkout/tax.ts and run the tests',
      startedAt: now - 130 * MIN, sentAt: now - 130 * MIN, lastAt: now - 25 * MIN,
      todos: [
        { text: 'Round tax per line to the cent', status: 'completed' },
        { text: 'Fix the two failing tax tests', status: 'in_progress', activeForm: 'Fixing the two failing tax tests' },
        { text: 'Update the receipt snapshot', status: 'blocked' },
      ],
      files: ['src/checkout/tax.ts', 'test/tax.test.ts', 'test/receipt.test.ts'],
    },
    {
      id: 2, title: 'Why is CI red?', parent: 1, state: 'answered', todos: [], files: [],
      prompt: 'wait, why is CI red on main since this morning? just look, short answer',
      startedAt: now - 110 * MIN, sentAt: now - 110 * MIN, lastAt: now - 100 * MIN,
    },
    {
      id: 3, title: 'Bump Node 20 to 22 in CI', parent: 2, state: 'done',
      prompt: 'ok bump Node 20 to 22 in the CI workflow and .nvmrc, then commit',
      startedAt: now - 95 * MIN, sentAt: now - 95 * MIN, lastAt: now - 80 * MIN,
      todos: [{ text: 'Use Node 22 in the CI workflow', status: 'completed' }],
      files: ['.github/workflows/ci.yml', '.nvmrc', 'package.json'],
    },
    {
      id: 4, title: 'Show tax on each cart line', state: 'active',
      prompt: 'next, show the tax on each cart line in src/cart/CartTable.ts, formatted with formatMoney, and add a test',
      startedAt: now - 18 * MIN, sentAt: now - 4 * MIN, lastAt: now - 2 * MIN,
      todos: [
        {
          text: 'Add a tax column to CartTable', status: 'in_progress', activeForm: 'Adding a tax column to CartTable',
          description: 'Add a Tax column after Price in src/cart/CartTable.ts. Read the rate from the line item, not the cart, so mixed-rate carts show the right tax per line. Keep the column right-aligned like Price.',
        },
        { text: 'Format it with formatMoney', status: 'pending' },
        { text: 'Add a cart table test', status: 'pending' },
      ],
      files: ['src/cart/CartTable.ts'],
      plan: planSteps(DEMO_PLAN),
    },
  ],
  log: [
    { kind: 'prompt', text: 'fix the rounding in tax.ts', thread: 1 },
    { kind: 'todo', text: '0/3 todos done', thread: 1 },
    { kind: 'edit', text: 'checkout/tax.ts', thread: 1 },
    { kind: 'edit', text: 'test/tax.test.ts', thread: 1 },
    { kind: 'prompt', text: 'why is CI red?', thread: 2 },
    { kind: 'agent', text: 'helper: read the CI logs', thread: 2 },
    { kind: 'prompt', text: 'bump Node 20 to 22 in CI', thread: 3 },
    { kind: 'edit', text: 'workflows/ci.yml', thread: 3 },
    { kind: 'edit', text: '.nvmrc', thread: 3 },
    { kind: 'commit', text: 'commit: Use Node 22 in CI', thread: 3 },
    { kind: 'return', text: 'back to Fix checkout tax rounding', thread: 1 },
    { kind: 'edit', text: 'test/receipt.test.ts', thread: 1 },
    { kind: 'test', text: 'tests fail: npm test: 11 pass, 1 fail', thread: 1 },
    { kind: 'error', text: 'Bash: receipt total off by 1 cent in receipt.test.ts', thread: 1 },
    { kind: 'prompt', text: 'next, show the tax on each cart line', thread: 4 },
    { kind: 'todo', text: '0/3 todos done', thread: 4 },
    { kind: 'edit', text: 'cart/CartTable.ts', thread: 4 },
    { kind: 'prompt', text: '[Image #1] - keep the tax column narrow, right-aligned like Price', thread: 4, at: now - 4 * MIN, gist: '' }, // '': no model in the demo, the prompt as typed
  ],
  lastTest: { ok: false, text: 'npm test: 11 pass, 1 fail' },
})

const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Sample Artifacts this project published, spread over days. */
export const demoArtifacts = (now: number): ArtifactRow[] =>
  [
    { title: 'tax rounding: before and after', created: now - 2 * HOUR, modified: now - 25 * MIN, url: 'https://claude.ai/code/artifact/4f1c2b7e-tax-rounding' },
    { title: 'release notes v2.4 draft', created: now - 40 * MIN, modified: now - 6 * MIN, url: 'https://claude.ai/code/artifact/9a3e51d0-release-notes' },
    { title: 'checkout load test report', created: now - 5 * DAY, modified: now - 1 * DAY, url: 'https://claude.ai/code/artifact/c27d8e44-checkout-load-test' },
    { title: 'payments security audit', created: now - 9 * DAY, modified: now - 9 * DAY, url: 'https://claude.ai/code/artifact/e80b13fa-payments-audit' },
    { title: 'Settings dark mode options', created: now - 26 * HOUR, modified: now - 20 * HOUR, url: 'https://claude.ai/code/artifact/71d0c9b2-dark-mode' },
  ].sort((a, b) => b.modified - a.modified)

/** Haiku's real reply (claude-haiku-5-5, 2026-11-24) to summaryPrompt(summaryInput(demoObserved)): 501 chars of JSON. */
/**
 * The board is a kanban: newest first in each column, whatever order Haiku gave. A task sorts by its todo's last
 * change, else its thread's last time, else the newer thread and later todo first; a task with no known #id goes last.
 */
export function sortSummary(s: Summary, o: Observed): Summary {
  const when = (t: SummaryTask): number[] => {
    const m = t.ref?.match(/^#(\d+)(?:\.(\d+))?/)
    const th = m ? o.threads.find(x => x.id === Number(m[1])) : undefined
    if (!th) return [-1, -1, -1]
    const i = m![2] ? Number(m![2]) - 1 : -1
    return [th.todos[i]?.at ?? th.lastAt ?? 0, th.id, i]
  }
  const tasks = s.tasks.map(t => [t, when(t)] as const).sort(([, a], [, b]) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!).map(([t]) => t)
  return { ...s, tasks, remaining: tasks.filter(t => t.status === 'remaining').map(t => t.name) }
}

/** Stamps `at` on each todo this event added or changed (status or text); the rest keep their time. */
export function touchTodos(prev: Observed, next: Observed, at: number): Observed {
  const old = new Map(prev.threads.flatMap(t => t.todos.map(d => [`${t.id}|${d.id ?? d.text}`, d] as const)))
  const touch = (id: number, d: Todo): Todo => {
    const was = old.get(`${id}|${d.id ?? d.text}`)
    return was && was.status === d.status && was.text === d.text ? (d.at === was.at ? d : { ...d, at: was.at }) : { ...d, at }
  }
  return { ...next, threads: next.threads.map(t => ({ ...t, todos: t.todos.map(d => touch(t.id, d)) })) }
}

export const DEMO_REPLY =
  '{"p":29,"t":[["Round tax per line","d","Tax now rounds to the cent per line.","#1.1"],["Fix tax tests","r","Two tax tests still fail; paused.","#1.2"],' +
  '["Update receipt snapshot","b","Waiting on the one-cent receipt fix.","#1.3"],["Use Node 22","d","CI now runs on Node 22.","#3.1"],' +
  '["Add tax column","a","Adding a tax column to CartTable now.","#4.1"],["Format with formatMoney","r","Format the new tax column.","#4.2"],' +
  '["Add cart table test","r","Write a test for the cart table.","#4.3"]],' +
  '"b":["Receipt total is off by 1 cent in receipt.test.ts."]}'
export const demoSummary: Summary = sortSummary(parseSummary(DEMO_REPLY), demoObserved(0))
