# Whatcha doing: design

The band sits above the prompt, like ponytail's band. It pushes the chat up; it cannot draw over it.

The point: one look tells the owner which prompt this tab got and what it did, so it is not confused with a
sibling tab doing a similar job. Every line uses the owner's own prompt words, file names, numbers and
errors, never generic labels.

All looks are settled. Nothing is open.

- **Place**: a band above the prompt, no sidebar or side pane.
- **Sizes**: header buttons ` S ` (the one status row), ` M ` (5 body lines), ` L ` (the full body). Each
  label has a space on both sides, so the click target is 3 columns wide. The shown size is bold in the
  accent color. A tab keeps M; from the one row it opens L. `/whatcha compact` opens M.
- **M**: Threads shows 5 rows of the timeline (the same rows and indents as L), the newest at the bottom.
  The top row is always the head of the thread the top visible row belongs to, like a navbar. Status row + hairline + 5 rows must fit the
  engine's `maxRows`, or the engine scrolls the band and a row is lost: M draws `min(5, maxRows - header
  - 1)` rows (header: 1 row, 2 under 120 columns). Summary shows the head or updating bar, Active and Stuck, and Work left. Artifacts shows the header and the
  newest one.
- **Height**: L's body is 20% of the terminal rows, at most 22 and at least 3 (24 rows: 4, 50: 10, 120: 22).
  Claude Code also caps the band at half the terminal (`maxRows`).
- **Scroll**: ` ⤒ ` ` ▲ ` ` ▼ ` ` ⤓ ` (3 columns wide each) sit left of the tabs in M and L when the
  Threads timeline is taller than the shown rows. ▲ ▼ move it a page a click (the shown rows less 1), ▲
  back to older rows, ▼ toward the newest; ⤒ ⤓ jump to the oldest and the newest. The mouse wheel over
  the band moves it a row a tick (`ui.scroll`, the engine's own window stays put). An arrow that cannot
  move is dim. The band opens on the newest rows, so new events stay in view; a size or tab change goes
  back there. Threads never ends in "+N more": every row is reachable by scrolling.
- **Layout**: every Threads row, thread rows and sub rows alike, keeps 2 columns at the right: tests ┊
  time. Each is a fixed-width box that never shrinks; the text box grows and shrinks (`minWidth 0`) and is
  cut with "…" at the first ┊, so no text runs into or under the columns, every ┊ sits in the same place
  top to bottom, and every row is exactly one line.
- **Full width**: titles, test runs, commits and errors are kept up to 200 characters, so every row is cut
  only at the real right edge of the band or its column. A test row names only the test run of a chain
  (`sed …; tsc && claude plugin test .` reads `claude plugin test .`). A title drops a leading list mark or
  quote (`- `, `1. `, `> `, `[ ]`).
- **Show all**: a cut Artifacts list ends in "+N more" (Threads scrolls instead). A click, or `/whatcha all`, grows the band to every row
  Claude Code gives it; the engine scrolls the rest. `Show less`, a size button, a tab, or the ring leaving
  the band goes back.
- **Status row** (S, and the header of M and L): `▸ Now (X/N): <latest prompt>  │ tabs`, X of N threads
  done; the glyph is the thread's own, as in the Threads tab. The latest prompt, cleaned, uses all the room up to a dim │ before the tabs, the three sizes and `▾` on the right, and is cut
  only at that edge. Under 120 columns the buttons take a second row.
- **Hidden**: `▾` shrinks the band to one right-aligned button, `▴ @whatcha-doing`.
- **Tabs**: Threads · Summary · Artifacts, clicked. The band never shows key labels or "press x" text:
  keys go to the prompt box, and the band almost never has focus.
- **Threads tab**: one timeline at the full band width (no side column) of every thread, oldest at the
  top like the chat: finished ones, then open ones, the current one last, oldest first in each group. Every thread is expanded,
  and every task and plan step has its own row. Indents show the hierarchy:
  1. col 0: the head, `▸` now (accent), `✓` done, `✗` a stuck task, `⏸` paused (the same glyphs in S, M
     and L); the name in bold, taking all the width up to the first ┊. Then the 2 **columns**, on every
     row of the timeline, right-aligned:
     - tests: `18✓ 1✗`, the pass count and ✓ green, the fail count and ✗ red, no words; 3 digits kept for
       each (1000 and up reads `1.2k`), and the column grows to its longest cell, the same on every row.
       Empty with no run, or a run with no count read. A thread row shows its last run; a test sub row its own.
     - time: `10:42`, dim. A thread row shows when the owner last sent it a prompt (`sentAt`); each sub row
       when it happened (an edit, a commit, a test run, a helper finishing, a later prompt), so the
       column fills top to bottom. Live, times come from `prompt.submit` and `tool.call`; rebuilt threads
       take them from the `timestamp` of each line in the session's transcript file
       (`~/.claude/projects/<cwd>/<session id>.jsonl`, its last 4 MB): the prompt's line, and each tool
       result's line by its `tool_use_id`.
     A ` ┊ ` in `#3a3a3a`, much fainter than dim, separates the columns. No model;
  2. col 2: `Plan · N steps`; only the current thread's plan unfolds at col 4: section headings bold and
     dim, items under them at col 6 with their own number (`1.`) or `·`, each nested level 2 deeper;
  3. col 2: each task, `✓` done (dim), `●` running, `○` to do, `✗` stuck; its subject only. A thread with
     no tasks shows its last 3 things done instead, newest lowest: `✎ spec/icons.md` edits, `✓`/`✗` test
     runs, `◆` commits, `↳` helpers; their time and counts in the columns;
  4. col 2: each later prompt to the thread, `› <prompt>` (the last 3, newest lowest), shown at
     `prompt.submit`; up to 2 rows each, wrapped inside the left area, cut with "…" at the end of the second;
  5. col 2: `❯ <activeForm>…` of the running task (accent), word for word from TaskCreate or TodoWrite,
     the lowest row, like the chat's spinner.
  The first prompt has no row: the thread's name and time point back to it.
- **Thread names**: a thread's name is its first prompt, cleaned: no tags (`[Image #1]`, `[Pasted text
  #2]`, engine wrappers like `<pasted_content id="384e">` with the text inside kept), links, absolute
  paths, list marks or cues (`okay so`, `wait,`, `new thing:`), at the full width
  up to the first meta cell. Only when nothing is left (a prompt of tags, links and paths) does the
  on-device name stand in: the first prompt goes to Apple's on-device model (FoundationModels, via
  `helper/ondevice.swift`) in the background after `prompt.submit`, never blocking it; its 3-6 word
  reply is stored as `name`. A reply under 3 or over 6 words, or ending on a pointing or function word
  (`these`, `it`, `its`, `the`, `to`), is dropped; the title from the prompt's first whole clause then
  stands in ("where are these? the rule files" reads `Rule files`).
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
  guess…`), then a board of Done, Active, Stuck, Left, each task with one plain line, blockers in red,
  and one full-width "Work left" row. Each board column is at least 34 columns wide: columns per row =
  max(1, floor(width / 34)), so 4 across at 160, 2 at 80, 1 at 60. Columns in a row share the width
  evenly (3-column gaps). With one column the plain line sits on the task's row.
  While Haiku runs, a thin bar (`━━━╸────  updating with Haiku  3 s`) sits under the head and fills over
  ~8 s without reaching the end; the last board stays below it. With no estimate yet the bar shows alone.
  Haiku runs only while this tab is shown, or on ↻ (refresh), cached until the state changes. The demo shows
  a real Haiku reply, frozen.
- **Summary budget**: at most 600 input and 250 output tokens per call. The input is a compact digest
  (one line per thread with counts, at most 10 todos, only the last test and error, oldest lines dropped
  past 1800 chars). The reply is short-key JSON, at most 8 tasks as `[name, d|a|b|r, ≤8 words]`; work
  left is the left tasks, not asked again. The frozen demo reply is 501 characters, about 125 tokens.
- **Artifacts tab**: every Artifact the project published (from the Artifact tool's publish calls),
  newest change first. Two lines each, tied by a dim dot and hook: `● <name>`, then
  `╰╴🔗 <link>` (dim). 🔗 is 2 columns wide; the link is cut 3 columns sooner for it. Two fixed
  10-column fields at the far right, Created and Modified, under a dim header row; values are
  right-aligned so every row lines up. Long names and links end in "…" so the fields never move.
  Kept across sessions in `$.store`, one key per project folder. A click on the name copies the link; the link line is a real hyperlink (OSC 8) that opens on click.
  No model calls.
