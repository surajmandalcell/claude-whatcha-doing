<h1 align="center">Watcha Doing Claude 🥀</h1>

<p align="center">
  <b>See what each Claude Code tab is doing. Right above the prompt.</b><br>
  Your prompts, Claude's tasks, and what passed or failed, in one band.
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#how-to-use">How to use</a> &nbsp;·&nbsp;
  <a href="https://github.com/surajmandalcell/claude-whatcha-doing/issues">Report a problem</a>
</p>

<p align="center">
  <a href="https://github.com/surajmandalcell/claude-whatcha-doing"><img src="https://img.shields.io/badge/Claude_Code-mod-d97757" alt="Claude Code mod"></a>
  <a href=".claude-plugin/plugin.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsurajmandalcell%2Fclaude-whatcha-doing%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/cover.png" alt="A Claude Code session in iTerm with the band above the prompt and the Threads tab open" width="880">
</p>

## Why whatcha-doing

You keep many Claude Code tabs open, and they often do similar jobs. After a while you cannot tell which tab is which.

- **One look.** The band names what you asked this tab and what it did.
- **Your words.** Rows use your prompts, file names, test counts and errors, not generic labels.
- **Out of the way.** One status row by default. Hide it with `▾`.
- **Cheap.** No model runs unless you open Summary.

## Features

---

**Threads** is the main tab, shown in the cover above. Your prompts form a timeline of threads, newest at the bottom. Under each one are Claude's tasks, plan steps and recent work. Two columns on the right show the tests (`18 ✓ Pass`, `4✓ 1✗`) and the time of each row.

---

<img src="docs/summary.png" alt="The Summary tab with Done, Active, Stuck and Left columns">

**Summary**<br>
Haiku estimates how far along the work is, as a board: Done, Active, Stuck and Left, newest on top.

---

<img src="docs/collapsed.png" alt="The band as one status row above the prompt">

**One status row**<br>
Size S. It shows what this tab is doing now and how many threads are done.

---

<img src="docs/artifacts.png" alt="The Artifacts tab with five published pages">

**Artifacts**<br>
Every page this project published, newest first. Click a name to copy its link.

---

<img src="docs/minimized.png" alt="The band hidden to one small label">

**Hidden**<br>
Click `▾` and the band shrinks to one small label. Click it to bring the band back.

---

There is more: on a Mac with Apple Intelligence, the on-device model writes short thread names and one-line gists of older prompts. The 🤖/👤 button switches between gists and your raw prompts. `/whatcha all` shows every row with no height limit.

## Install

Run this in a terminal:

```sh
claude plugin marketplace add surajmandalcell/claude-whatcha-doing
claude plugin install whatcha-doing@claude-whatcha-doing
```

New sessions show the band at once. In a session that is already open, run `/reload-plugins`.

<details>
<summary>Updates</summary>

<br>

To get new versions on start, run `/plugin`, open Marketplaces, pick `claude-whatcha-doing`, and turn on auto-update. To update by hand:

```sh
claude plugin marketplace update claude-whatcha-doing
claude plugin update whatcha-doing@claude-whatcha-doing
```

</details>

## How to use

Click the tabs and buttons in the band. Your keys still go to the prompt.

| Size | What it shows |
| --- | --- |
| **S** | One status row: `▸ Now (2/4): <your last prompt>` |
| **M** | 6 rows of the open tab |
| **L** | Up to 22 rows, or 20% of the screen |
| **▾** | Hides the band to `▴ @whatcha-doing` |

In M and L, `▲ ▼` scroll the Threads timeline a page, and `⤒ ⤓` jump to the oldest or newest row. The mouse wheel works too.

**Remember view:** the size, 🤖/👤 and tab are saved; global by default, per project in `/plugin` → whatcha-doing settings.

<details>
<summary>Slash commands</summary>

<br>

| Command | What it does |
| --- | --- |
| `/whatcha threads` | Open Threads |
| `/whatcha summary` | Open Summary |
| `/whatcha artifacts` | Open Artifacts |
| `/whatcha compact` | Size M |
| `/whatcha close` | Size S |
| `/whatcha min` | Hide the band |
| `/whatcha all` | Show every row, no height limit |
| `/whatcha demo`, `/whatcha live` | Show sample data, or go back to this session |

Set `WHATCHA_DEMO=1` to start in demo mode.

</details>

## How it works

- **Hooks, no model.** Threads and Artifacts are built from Claude Code's own events. Loaded mid-session, the band rebuilds the threads from the transcript.
- **Haiku runs only on Summary.** It runs when you open that tab or click ↻, never on its own. One call is at most 600 tokens in and 250 out, and the answer is cached until the session changes.
- **Haiku sees a short digest.** Thread and task names (cut to 40 characters), their states, file and commit counts, and the last test and error line. No full prompts, replies or file contents.
- **Thread names stay on your Mac.** Apple's on-device model writes them. Nothing is sent.
- **Artifacts stay local.** The list is kept in the mod's local store, one list per project folder.

## Develop

```sh
claude --plugin-dir /path/to/claude-whatcha-doing   # load a clone for one session
claude plugin validate . && claude plugin test .
zsh scripts/release.zsh                              # checks, bumps the version, commits and pushes
zsh scripts/readme-images.zsh                        # remakes docs/*.png from the captures in docs/src/
```

Installed copies update only when the version in `.claude-plugin/plugin.json` changes. Design notes are in [specs/design.md](specs/design.md).

## License

[MIT](LICENSE)
