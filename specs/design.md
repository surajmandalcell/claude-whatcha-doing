# Whatcha doing: design

The band sits above the prompt, like ponytail's band. It pushes the chat up; it cannot draw over it.

The point: one look tells the owner which prompt this tab got and what it did, so it is not confused with a
sibling tab doing a similar job. Every line uses the owner's own prompt words, file names, numbers and
errors, never generic labels.

All looks are settled. Nothing is open.

- **Place**: a band above the prompt, no sidebar or side pane.
- **Sizes**: header buttons ` S ` (the one status row), ` M ` (6 body lines), ` L ` (the full body). Each
  label has a space on both sides, so the click target is 3 columns wide. The shown size is bold in the
  accent color. A tab keeps M; from the one row it opens L. `/whatcha compact` opens M.
- **M**: Threads shows 6 rows of the timeline (the same rows and indents as L), the newest at the bottom.
  The top row is always the head of the thread the top visible row belongs to, like a navbar. Status row + hairline + 6 rows must fit the
  engine's `maxRows`, or the engine scrolls the band and a row is lost: M draws `min(6, maxRows - header
  - 1)` rows (header: 1 row, 2 under 120 columns). Summary shows the same board as L, one row per task (name only), as many as fit. Artifacts shows the header and the
  newest one. M always draws its full 6 rows (blank ones under short content) on every tab, so nothing below moves when a tab or the content changes.
- **Height**: L's body is 20% of the terminal rows, at most 22 and at least 3 (24 rows: 4, 50: 10, 120: 22).
  Claude Code also caps the band at half the terminal (`maxRows`).
- **Scroll**: ` ⤒ `` ▲ `` ▼ `` ⤓ ` (3 columns wide each, no gap) sit after the 🤖 button in M and L when the
  Threads timeline is taller than the shown rows. ▲ ▼ move it a page a click (the shown rows less 1), ▲
  back to older rows, ▼ toward the newest; ⤒ ⤓ jump to the oldest and the newest. The mouse wheel over
  the band moves it a row a tick (`ui.scroll`, the engine's own window stays put). An arrow that cannot
  move is dim. The band opens on the newest rows, so new events stay in view; a size or tab change goes
  back there. Threads never ends in "+N more": every row is reachable by scrolling.
- **Layout**: every Threads row, thread rows and sub rows alike, keeps 3 columns at the right: refresh ┊
  tests ┊ time. Each is a fixed-width box that never shrinks; the text box grows and shrinks (`minWidth 0`) and is
  cut with "…" at the first ┊, so no text runs into or under the columns, every ┊ sits in the same place
  top to bottom, and every row is exactly one line.
- **Full width**: titles, test runs, commits and errors are kept up to 200 characters, so every row is cut
  only at the real right edge of the band or its column. A title drops a leading list mark or
  quote (`- `, `1. `, `> `, `[ ]`).
- **Show all**: a cut Artifacts list ends in "+N more" (Threads scrolls instead). A click, or `/whatcha all`, grows the band to every row
  Claude Code gives it; the engine scrolls the rest. `Show less`, a size button, a tab, or the ring leaving
  the band goes back.
- **Status row** (S, and the header of M and L): `▸ Now (X/N): <latest prompt>  │ tabs`, X of N threads
  done; the glyph is the thread's own, as in the Threads tab. 🤖: the latest prompt's 3-6 word on-device brief
  (else its gist), the same spinner line as its `›` row while the model writes it or waits to retry; 👤 or no gist: the latest prompt, cleaned. It uses all the room up to a dim │ before the tabs, the three sizes and `▾` on the right, and is cut
  only at that edge. Under 120 columns the buttons take a second row.
- **Header**: after the │, left to right with no gaps: ` Threads `` Summary `` Artifacts ` ┊ ` S `` M ``
  L ` ┊ ` 🤖 ` ┊ ` ⤒ `` ▲ `` ▼ `` ⤓ ` ` ▾ `. Each label has 1 space each side; the ┊ dividers are `#3a3a3a`.
- **🤖 / 👤**: one button after the sizes. 🤖 (default) shows the on-device gists; 👤 shows the prompts as
  typed, in the status row and every thread name and prompt row, in S, M and L. 2 columns wide, in a 4-wide box.
- **Remember view**: the size (S, M, L, hidden), 🤖/👤 and the open tab are kept in `$.store` and come
  back in the next session. The plugin setting `rememberView` (/plugin → whatcha-doing): `global`
  (default, one view for all sessions) or `per project` (one per cwd, key `view:<cwd>`; a project with
  nothing saved starts from the global view).
- **Hidden**: `▾` shrinks the band to one right-aligned button, `▴ @whatcha-doing`.
- **Tabs**: Threads · Summary · Artifacts, clicked. The band never shows key labels or "press x" text:
  keys go to the prompt box, and the band almost never has focus.
- **Threads tab**: one timeline at the full band width (no side column) of every thread, oldest at the
  top like the chat: finished ones, then open ones, the current one last, oldest first in each group. Every thread is expanded,
  and every task and plan step has its own row. Indents show the hierarchy:
  1. col 0: the head, `▸` now (accent), `✓` done, `✗` a stuck task, `⏸` paused (the same glyphs in S, M
     and L); the name in bold, taking all the width up to the first ┊. Then the 3 **columns**, on every
     row of the timeline:
     - refresh, 3 wide: the thread row and every `›` row hold a plain dim ` ↻ ` button; other rows leave
       it blank. A press asks the model for that prompt's gist again, with the chat's 3 earlier prompts as
       context (each its gist, else its text cut to 200 chars), the same checks, the spinner meanwhile. The
       new gist replaces the old one (and the thread's when the prompt opened it); a failed redo keeps the old.
     - tests, right-aligned: `18 ✓ Pass` in green when every test passed, `3 ✗ Fail` in red when every test failed, and
       the compact `18✓ 1✗` (pass green, fail red) when both; 1000 and up reads `1.2k`. The column grows to
       its widest cell (at least 9), the same on every row.
       Empty with no run, or a run with no count read. Only the thread row shows a count: its last run.
     - time: `10:42, 2d`, dim: the clock time, then whole calendar days ago (`0d` today, `1d` yesterday). A thread row shows when the owner last sent it a prompt (`sentAt`); a `›` row
       when it was sent; a result line when the turn's last work happened (an edit, a commit, a test run,
       a helper finishing). Live, times come from `prompt.submit` and `tool.call`; rebuilt threads
       take them from the `timestamp` of each line in the session's transcript file
       (`~/.claude/projects/<cwd>/<session id>.jsonl`, the whole file cut by `jq` to its user lines, about 1/300 of it, so a 100 MB file still fits the 4 MB a run returns; without `jq`, its last 4 MB): the prompt's line, and each tool
       result's line by its `tool_use_id`.
     A ` ┊ ` in `#3a3a3a`, much fainter than dim, separates the columns. No model;
  2. col 2: `Plan · N steps`; only the current thread's plan unfolds at col 4: section headings bold and
     dim, items under them at col 6 with their own number (`1.`) or `·`, each nested level 2 deeper;
  3. col 2: each task, `✓` done (dim), `●` running, `○` to do, `✗` stuck; its subject only. A thread
     opened by an edit is named `Edited files`;
  4. col 2: each later prompt to the thread, `› <gist>` (the last 3), shown at `prompt.submit`. While the
     model sums it up: `⠹ summarizing…` in Claude blue (`claude`), after a miss `⠹ retrying, try N of 3`
     (`warning`), then the prompt as typed, dim, on the same row; the spinner turns every 120 ms, only
     while some prompt waits. Then the gist, else the prompt. Only the newest prompt of the whole timeline
     takes 2 rows, wrapped inside the left area, cut with "…" at the end of the second; while it waits it
     is one row, like any other, and the gist (asked to fit the row) fills that row in place, so no row
     moves. Every older prompt is one row, cut at the ┊.
     **Turns**: prompts sent before Claude replies stack as `›` rows. When Claude replies (`turn.complete`
     with an answer; in a rebuild, the next prompt), one dim result line goes under the stack at col 4:
     `⎿ 3 files changed · 1 commit · 1 helper started · took 2m 11s`, counting the work since the first
     prompt of the turn, in words, never a command or a path; "took" runs from that prompt to the last
     work. Parts with nothing to count drop; no work, no line. Tests never go in it: the tests column
     shows each turn's last test run on the row of its last prompt (the head row: the first turn's). The reply is
     a `reply` log entry, so a rebuild draws the same rows;
  5. col 2: `❯ <activeForm>…` of the running task (accent), word for word from TaskCreate or TodoWrite,
     the lowest row, like the chat's spinner.
  The first prompt has no row: the thread's name and time point back to it.
  **Jump**: the thread name and each `›` prompt are plain buttons, with no mark at rest; under the pointer
  the text turns the accent color (`suggestion`), underlined. A press scrolls the chat to that prompt
  (`$.ui.scroll({ to: { requestId }, block: 'start' })`), by the `requestId` a passive
  `ui.render` hook on `UserMessage` saw for the prompt's first 60 chars. Not drawn yet, or denied: the
  toast "That prompt is not drawn in the chat yet".
- **Thread names**: a thread's name is its first prompt, cleaned: no tags (`[Image #1]`, `[Pasted text
  #2]`, engine wrappers like `<pasted_content id="384e">` with the text inside kept), links, absolute
  paths, list marks or cues (`okay so`, `wait,`, `new thing:`), at the full width
  up to the first meta cell. Only when nothing is left (a prompt of tags, links and paths) does the
  on-device name stand in: the first prompt goes to Apple's on-device model (FoundationModels, via
  `helper/ondevice.swift`) in the background after `prompt.submit`, never blocking it; its 3-6 word
  reply is stored as `name`. A reply under 3 or over 6 words, or ending on a pointing or function word
  (`these`, `it`, `its`, `the`, `to`), is dropped; the title from the prompt's first whole clause then
  stands in ("where are these? the rule files" reads `Rule files`).
- **Prompt gists**: a prompt of 40 characters or more (after cleaning) goes to the on-device model
  with "one line of about N words (about C characters), like a detailed commit subject that keeps the key details" (C: the `›` row's text width at the band's last draw, in any tab or size, so a gist asked while Threads is hidden or collapsed still fills its row; N: the smaller of C / 7 and a third of the prompt's words, 6 to 18; a target, because given a range the model stays at its low end), one call at a time in the background, never on
  redraw. A just-sent prompt goes first in line, ahead of the load queue (the newest 20 long prompts
  without one; older ones show as typed). The full prompt is sent, cut to 4000 characters (about 1000 of
  the model's 4096 tokens, about 8 s), never skipped. A reply under 3 or over 9 words (never cut), ending
  on a dangling word, or that only repeats the prompt's opening words is dropped, and the model is asked
  once more for 3 to 5 words. When both replies are dropped, `gist` is `''` and the prompt shows.
  No answer at all (a helper error or timeout) shows `retrying, try N of 3` and asks again in the
  background after 5 s, 20 s and 60 s, never blocking other prompts; after the third miss `gist` is `''`
  with `failed: true`, and the next session asks those again first (inside the 20 load asks).
  The reply is stored as `gist` on the prompt's log entry (and on its thread when it opened it), and the
  write redraws the band. A just-sent prompt also gets `brief`, 3 to 6 words for the status row: the
  gist when it is short enough, else the 3 to 5 word ask. The thread row shows the gist of its first
  prompt in place of the prompt; a `›` row shows its own. The helper exits 2 only when the model can
  never answer on this Mac (Apple Intelligence off, Mac not eligible): `onDevice` answers `null`, the
  prompt shows as typed with no retry, and the asks stop until restart (no Command Line Tools answers
  `null` too). A failed request (a guardrail, a model still loading, a timeout) exits 1: `undefined`,
  and that prompt is retried as above.
- **New topic**: a prompt with 8 or more topic words that shares none with the current thread's name and
  prompts opens a new thread, even without a cue like "new thing". Picks pasted from an options page
  (every line `- Name: pick`) always answer the current thread.
- **History**: when the mod loads mid-session (a reload, a resume) and the transcript
  (`$.session.messages()`, newest 4096 messages) has more prompts than the band saw (or the band has prompts without times), the threads are
  rebuilt from it: prompts, tasks, plans, test runs, commits and edits, the last 200 prompts at most.
  Names of known threads stay. The messages have no times, so the times come from the `.jsonl`
  file's tail, read with `tail -c 4000000` (`$.fs.read` stops at 4 MiB), each prompt matched by its text. The
  compaction summary ("This session is being continued from a previous conversation…") is engine text,
  never a prompt: its work stays in the thread before it, or "Earlier work".
- **Plans**: the ExitPlanMode call's plan markdown, or the plan file Claude writes under
  `~/.claude/plans/`, is parsed into steps and stored on the current thread. Numbered (`1.`, `1)`) and
  bulleted items keep their nesting; a wrapped item's next lines join it; headings stay as section
  labels; prose, code blocks and headings with no items under them drop.
- **Summary tab**: Haiku's estimate, marked as an estimate (`~38% done ▰▰▰▰▱▱▱▱▱▱ estimate: Haiku's
  guess…`), then a kanban board of Left, Active, Stuck and Done, left to right, each task with one plain line, blockers in red,
  and one full-width "Work left" row. Columns by band width, each at least 30 wide with 3-column gaps:
  4 across from 129, 2 x 2 from 63 (Left, Active on top; Stuck, Done below), else 1 in the same order
  (150 cols: 4, 100: 2 x 2, 60: 1). In a column a task name and
  its plain line each wrap to 2 lines, then cut with "…"; with one column they share one row. A cut
  column ends in "+N more" (whole tasks). All 4 headers always show; an empty column has one dim line:
  `nothing left`, `nothing running`, `✓ nothing stuck` (✓ green), `nothing finished yet`. In one column the
  empty groups share one line (`Stuck: nothing  ·  Done: nothing`). Like a kanban, every column lists the newest first:
  Haiku names each task's source (`#3` a thread, `#3.2` its 2nd todo), and the band sorts by that todo's last
  change, else the thread's last time, else the newer thread and later todo; "+N more" cuts the oldest.
  While Haiku runs, a thin bar (`━━━╸────  updating with Haiku  3 s`) sits under the head and fills over
  ~8 s without reaching the end; the last board stays below it. With no estimate yet the bar shows alone.
  Haiku runs only while this tab is shown, or on ↻ (refresh), cached until the state changes. The demo shows
  a real Haiku reply, frozen.
- **Summary budget**: at most 600 input and 250 output tokens per call. The input is a compact digest
  (one line per thread with counts, at most 10 todos, only the last test and the current thread's open error, oldest lines dropped
  past 1800 chars). The reply is short-key JSON, at most 8 tasks as `[name, d|a|b|r, ≤8 words]`; work
  left is the left tasks, not asked again. The frozen demo reply is 501 characters, about 125 tokens.
- **Errors**: a failed step marks its thread ✗ only while it is the last relevant result. A later step that
  works, a commit, a passing test or the turn ending with a reply clears the thread's earlier errors. Exit 1
  of a command ending in `grep`, `rg`, `test`, `[`, `diff` or `cmp` with no error text is "no match", not an
  error. A test command that fails with no pass or fail count (a missing script, a bad path) is a failed
  step, not a test result: it never blocks a task. Haiku sees only the current thread's last test.
- **Artifacts tab**: every Artifact the project published (from the Artifact tool's publish calls),
  newest change first. Two lines each, tied by a dim dot and hook: `● <name>`, then
  `╰╴🔗 <link>` (dim). 🔗 is 2 columns wide; the link is cut 3 columns sooner for it. Two fixed
  10-column fields at the far right, Created and Modified, under a dim header row; values are
  right-aligned so every row lines up. Long names and links end in "…" so the fields never move.
  Kept across sessions in `$.store`, one key per project folder. A click on the name copies the link; the link line is a real hyperlink (OSC 8) that opens on click.
  No model calls.
