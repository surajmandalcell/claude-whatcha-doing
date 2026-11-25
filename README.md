![Watcha Doing Claude: the Threads tab, a timeline on the left and a table of threads on the right](docs/threads.png)

<div align="center">

A band above the Claude Code prompt that shows what you asked each session and what it actually did.

[![Claude Code mod](https://img.shields.io/badge/Claude_Code-mod-d97757)](https://github.com/surajmandalcell/claude-whatcha-doing)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsurajmandalcell%2Fclaude-whatcha-doing%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

## Why

You keep many Claude Code tabs open, and they often do similar jobs. After a while you cannot tell which tab
is which. whatcha-doing shows, at a glance, what you asked each session, what it did, and what failed.

## Features

| | |
|---|---|
| ![Collapsed status row](docs/collapsed.png) | ![Summary board](docs/summary.png) |
| **Status row.** By default the band is one row: the thread you are on now, how many threads are done and, once you open Summary, a percent-done estimate. | **Summary.** One Haiku call sorts the tasks into Done, Active, Stuck and Left, each with a one-line note. |
| ![Artifacts list](docs/artifacts.png) | ![Minimized band](docs/minimized.png) |
| **Artifacts.** The pages this project published, newest change first. A click on the name copies the link; the link opens on click. | **Minimized.** `▾` shrinks the band to `▴ @whatcha-doing` on the right. |
| ![Show all](docs/show-all.png) | |
| **Show all.** A long list ends in "+N more". A click grows the band to show everything; `Show less` goes back. | |

**Threads** (the shot at the top) puts a timeline beside a table of every thread. Each prompt opens a thread.
A new prompt after work started is a side trip, shown under the thread it came from. Each thread shows your last
prompt (`❯`), what it did (`⏺`: files, tests, commits) and its last failure (`✗`).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install whatcha-doing --marketplace surajmandalcell/claude-whatcha-doing
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). The band shows at once.

From a shell:

```sh
claude plugin install whatcha-doing --marketplace surajmandalcell/claude-whatcha-doing
```

For development, load it from a clone. For one session:

```sh
claude --plugin-dir /path/to/claude-whatcha-doing
```

For every session, add the folder to the `env` block of `~/.claude/settings.json`. Saving a file then reloads the mod:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-whatcha-doing"
```

## Usage

The band is driven with the mouse: click the tabs and buttons. Keys still go to the prompt.

| Command | What it does |
|---|---|
| `/whatcha open` or `/whatcha threads` | Open the Threads tab |
| `/whatcha summary` | Open the Summary tab |
| `/whatcha artifacts` | Open the Artifacts tab |
| `/whatcha compact` | Compact: the 3 most useful lines of the tab |
| `/whatcha all` | Show everything, no height limit |
| `/whatcha close` | Minimize: back to the one status row |
| `/whatcha min` | Hide to `▴ @whatcha-doing` |
| `/whatcha demo`, `/whatcha live` | Show sample data, or go back to this session |

The header buttons pick the size: Minimize (one row), Compact (3 lines), Regular (up to 55% of the rows on a
terminal of 40 rows or more, within the half Claude Code gives the band). Set `WHATCHA_DEMO=1` to start in demo mode.

## Haiku budget

Only the Summary tab calls a model. It runs only when you open Summary or click Refresh, never on its own.
One call is at most 600 tokens in and 250 tokens out, and the answer is cached until the session changes.
Everything else is built from hooks alone, with no model call.

## Privacy

The Summary call sends a short digest: thread titles and task names (each cut to 40 characters), their states,
file and commit counts, and the last test and error line. Nothing from the transcript is sent: no full prompts,
no replies, no file contents. The Artifacts list is kept in the mod's local store, one
list per project folder. Nothing leaves your machine except that one Haiku call.

## Updates

Turn on auto-update once: `/plugin`, then Marketplaces, `claude-whatcha-doing`, Enable auto-update.
Claude Code then fetches each new version when it starts. To update by hand:

```sh
claude plugin marketplace update claude-whatcha-doing
claude plugin update whatcha-doing@claude-whatcha-doing
```

## Develop

```sh
claude plugin validate .
claude plugin test .
zsh scripts/release.zsh   # checks, bumps the patch version, commits and pushes
```

Installed copies update only when the version in `.claude-plugin/plugin.json` changes, so release with the script.

The design notes are in [specs/design.md](specs/design.md).

## License

[MIT](LICENSE)
