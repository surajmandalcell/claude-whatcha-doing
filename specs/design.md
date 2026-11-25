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
- **M**: Threads pins the current thread's head row on top at the full band width (no right column), then
  its 2 newest sub rows with the same indents as L (Claude's `❯` line, the results line), then the 2
  previous threads, one dim row each (see "Earlier threads"). ▲ ▼ go further back through older threads.
  Summary shows the head or updating bar, Active and Stuck, and Work left. Artifacts shows the header and the
  newest one.
- **Height**: L's body is 20% of the terminal rows, at most 22 and at least 3 (24 rows: 4, 50: 10, 120: 22).
  Claude Code also caps the band at half the terminal (`maxRows`).
- **Scroll**: ` ▲ ` and ` ▼ ` (3 columns wide) sit left of the tabs in M, and in L when the Threads list is
  cut. They move the rows under the pinned current-thread row one row a click, further back in time; an arrow that cannot move is
  dim. With no scroll the newest rows show, so new events stay in view; a size or tab change resets it.
- **Full width**: titles, test runs, commits and errors are kept up to 200 characters, so every row is cut
  only at the real right edge of the band or its column. A test row names only the test run of a chain
  (`sed …; tsc && claude plugin test .` reads `claude plugin test .`). A title drops a leading list mark or
  quote (`- `, `1. `, `> `, `[ ]`).
- **Show all**: a cut list ends in "+N more". A click, or `/whatcha all`, grows the band to every row
  Claude Code gives it; the engine scrolls the rest. `Show less`, a size button, a tab, or the ring leaving
  the band goes back.
- **Status row** (S, and the header of M and L): `▸ Now (X/N): <thread>  │ tabs`, X of N threads
  done; the glyph is the thread's own, as in the Threads tab. The thread name uses all the room up to a dim │ before the tabs, the three sizes and `▾` on the right, and is cut
  only at that edge. Under 120 columns the buttons take a second row.
- **Hidden**: `▾` shrinks the band to one right-aligned button, `▴ @whatcha-doing`.
- **Tabs**: Threads · Summary · Artifacts, clicked. The band never shows key labels or "press x" text:
  keys go to the prompt box, and the band almost never has focus.
- **Threads tab, left** (60% of the width): the current thread with its tasks and plan steps, in
  at most 60% of the body rows (when it does not fit, the done tasks and the plan steps fold away and
  `Plan · N steps` stays). Then a blank row and the earlier threads, open ones first, newest first, one
  row each: **Earlier threads**: glyph, name, and at the right edge the result counts and `sent 19:20`.
  Show all draws every thread in full, one blank row between threads. Every task and plan step has its own row. Indents show the hierarchy:
  1. col 0: the head, `▸` now (accent), `✓` done, `✗` a stuck task, `⏸` paused (the same glyphs in S, M and L); the name in bold;
     `  ·  now|paused|done|answered`; at the right edge `2 of 6 done` or `plan · 4 steps`, then a dim
     `  ·  sent 10:42`, the local clock time of the owner's last prompt to the thread (`sentAt`, stamped
     at `prompt.submit`);
  2. col 2: `❯ <activeForm>…` of the running task (accent), word for word from TaskCreate or TodoWrite;
  3. col 4: one results line from plain counts, `11 tests pass  ·  1 fails  ·  3 files  ·  1 commit`;
  4. col 2: each task, `✓` done (dim), `●` running, `○` to do, `✗` stuck; its subject only;
  5. col 2: `Plan · N steps`, then the plan at col 4: section headings bold and dim, items under them at
     col 6 with their own number (`1.`) or `·`, each nested level 2 deeper.
  No prompt quote and no model line: a thread points back to its prompt by its name and the time sent.
- **Thread names**: the first prompt of a new thread goes to Apple's on-device model (FoundationModels,
  via `helper/ondevice.swift`) in the background after `prompt.submit`, never blocking it. Its 3-6 word
  reply is stored on the thread as `name`. Without the model the name is the title from the prompt's first
  clause. The model is used for nothing else.
- **Plans**: the ExitPlanMode call's plan markdown, or the plan file Claude writes under
  `~/.claude/plans/`, is parsed into steps and stored on the current thread. Numbered (`1.`, `1)`) and
  bulleted items keep their nesting; a wrapped item's next lines join it; headings stay as section
  labels; prose, code blocks and headings with no items under them drop.
- **Threads tab, divider**: a faint `│` runs the full body height between the two columns.
- **Threads tab, right**: the current task in detail: `Now: <subject>` and `task 3 of 6`, Claude's
  activeForm in bold accent, the TaskCreate description word-wrapped, then `next  <next task or plan step>`.
  With no running task: `No task running.` and the next one.
- **Under 100 columns**: one column, the threads first, then the current task.
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
