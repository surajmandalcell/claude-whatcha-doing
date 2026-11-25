# Whatcha doing: design

The band sits above the prompt, like ponytail's band. It pushes the chat up; it cannot draw over it.

The point: one look tells the owner which prompt this tab got and what it did, so it is not confused with a
sibling tab doing a similar job. Every line uses the owner's own prompt words, file names, numbers and
errors, never generic labels.

All looks are settled. Nothing is open.

- **Place**: a band above the prompt, no sidebar or side pane.
- **Sizes**: header buttons `S` (the one status row), `M` (3 body lines: Threads the newest
  graph rows, Summary the head or updating bar, Active and Stuck, and Work left, Artifacts the newest one),
  `L` (the full body). The shown size is bold in the accent color. A tab keeps Compact; from the one
  row it opens Regular. `/whatcha compact` opens Compact.
- **Height**: Regular's body takes at least 6 rows, and on 40 or more rows up to 55%. On a shorter terminal
  it may take up to 90% less the prompt, but Claude Code caps the band at half the terminal (`maxRows`).
- **Show all**: a cut list ends in "earlier · N more" (timeline) or "+N more" (lists). A click, or
  `/whatcha all`, grows the band to every row Claude Code gives it; the engine scrolls the rest. The
  earlier row (now "earlier · show less"), `Show less`, a size button, a tab, or the ring leaving the band
  goes back.
- **Collapsed row**: `● now: <thread>  ·  X/N threads done  ·  ~45% ▰▰▱▱▱`, with the tabs, the three sizes
  and `▾` on the right. Under 120 columns the buttons take a second row.
- **Hidden**: `▾` shrinks the band to one right-aligned button, `▴ @whatcha-doing`.
- **Tabs**: Threads · Summary · Artifacts, clicked. The band never shows key labels or "press x" text:
  keys go to the prompt box, and the band almost never has focus.
- **Threads tab, left**: a git graph, newest at the bottom next to the prompt. Reads like
  `git log --graph`: every row draws every live lane, ticks included. A side trip forks on its own node
  (`├─● Why is CI red?`) and merges on the next row of the thread it returns to (`├─┴─╯ ✗ tests fail`);
  bends use rounded corners, `├` where a lane goes on. A cut end is dotted (`┆ earlier · 3 more`).
- **Threads tab, divider**: a faint `│` runs the full body height between the graph and the table, in
  every Threads view, show all included.
- **Threads tab, right**: a table under a dim header row (`4 threads`, then the column names):
  1. status glyph, title (not indented; the graph shows side trips), then fixed right-aligned columns
     Tasks (bar + x/y, 12 wide), Started and Last (9 wide each);
  2. dim `❯ "<the owner's last prompt to it, ~80 chars, cut at a word>"`;
  3. dim `⏺ <file names> · tests 41/42 · helper: <what> · commit: <message>`;
  4. the last failure on its own red line, `✗ 1 snapshot failed in Settings.test.tsx`.
  Lines 2-4 sit at the title's left edge, may run under Tasks, and are cut before the time columns. The
  current thread opens with its tasks one step in. No blank line between threads: the height cap has no
  room for it.
- **Summary tab**: Haiku's estimate, marked as an estimate (`~38% done ▰▰▰▰▱▱▱▱▱▱ estimate: Haiku's
  guess…`), then a board of Done, Active, Stuck, Left, each task with one plain line, blockers in red,
  and one full-width "Work left" row. Each board column is at least 34 columns wide: columns per row =
  max(1, floor(width / 34)), so 4 across at 160, 2 at 80, 1 at 60. Columns in a row share the width
  evenly (3-column gaps). With one column the plain line sits on the task's row.
  While Haiku runs, a thin bar (`━━━╸────  updating with Haiku  3 s`) sits under the head and fills over
  ~8 s without reaching the end; the last board stays below it. With no estimate yet the bar shows alone.
  Haiku runs only while this tab is shown, or on Refresh, cached until the state changes. The demo shows
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
