# backlog-md: Backlog.md for Claude Code

Track work on a [Backlog.md](https://github.com/MrLesk/Backlog.md) kanban board from Claude Code. This is an unofficial plugin; it isn't affiliated with the Backlog.md project.

The plugin asks where each project's board should live, sets up columns and required fields from presets, routes Claude's `backlog` commands to the right board, enforces your required fields, and commits and syncs the board.

The interactive guide is in the marketplace repository at `guide/backlog-md/index.html`.

## Install

Requirements: Claude Code, Git, Node.js 18+, and the Backlog.md CLI (`npm i -g backlog.md`, v1.55.3 or newer). macOS and Linux. Because the plugin ships a `bin/` directory, it works in Claude Code but not in claude.ai or Cowork.

```
/plugin marketplace add maxlk/claude-marketplace
/plugin install backlog-md@maxlk
```

To try it for one session from a local clone: `claude --plugin-dir /path/to/claude-marketplace/plugins/backlog-md`.

Start Claude Code in a project and it offers setup. You can also run `/backlog-md:setup` at any time.

## Storage

| Option | Where the board lives | Committed by |
|---|---|---|
| **Dedicated git ref** (default) | `backlog` branch with no shared history, checked out at `.git/backlog-wt` | Plugin |
| **New separate folder** | A folder of your choice, in its own git repository | Plugin |
| **Existing board** | The folder you point at | You |
| In the code tree | `backlog/` on your code branches | You |
| Private to this clone | `.git/backlog-local`, unversioned | Nobody |

## Commands

| Command | Purpose |
|---|---|
| `/backlog-md:setup` | First-time setup, or change columns, rules and settings |
| `/backlog-md:status [--web]` | Show the board, or open the web board |
| `/backlog-md:next` | Recommend the next task |
| `/backlog-md:start <id>` | Claim and plan a task |
| `/backlog-md:finish <id>` | Verify and complete a task |
| `/backlog-md:plan-to-tasks <spec>` | Break work into tasks |
| `/backlog-md:sync` | Sync now, or resolve a blocked sync |
| `/backlog-md:doctor [--audit]` | Diagnose the integration |

## What to expect

- **Required fields apply to Claude**, through a `backlog` wrapper on Claude's PATH. Your terminal and the web UI aren't gated; `/backlog-md:doctor --audit` reports what they let through.
- **Board commits skip your repository's git hooks and commit signing**, so that they can't hang or fail in the background. If you require those on the board branch, use a storage mode the plugin doesn't commit.
- **Approvals are guardrails, not a security boundary.** "Human approval" uses Claude Code's permission prompt, which permissive permission modes can skip.
- **Status callbacks are refused** until you trust them. Backlog.md's `onStatusChange` runs shell commands, and a board pulled from a shared branch could contain one.
- **Using the board from your own terminal**: on non-tree storage, run `backlog-md shell-init` inside Claude and add the printed `blg` function to your shell profile. Then use `blg board`, `blg browser`, and so on.

## Moving a board between storage modes

There's no automated migration in this version. To move a board onto a dedicated ref: copy the `backlog/` folder aside, run `/backlog-md:setup` and choose the dedicated ref, copy your `tasks/`, `milestones/`, `docs/` and `decisions/` folders into `.git/backlog-wt/backlog/`, then run `/backlog-md:sync`.

To reset a project: remove `.git/backlog-md/` (the plugin's per-clone settings). The board itself is left alone.

## Development

```
# from the repository root
BACKLOG_BIN_DIR=/dir/with/backlog npm test
claude plugin validate plugins/backlog-md
```

The tests use real Git repositories and the real Backlog.md CLI in temporary directories.

## License

MIT
