---
name: doctor
description: Diagnose and repair the Backlog.md integration - CLI version, routing, board health, duplicate IDs, tasks outside the project's rules.
argument-hint: "[--audit]"
disable-model-invocation: true
allowed-tools: Bash(backlog-md *), Bash(backlog *)
---

# Doctor

Arguments: $ARGUMENTS

Run `backlog-md doctor` and report failures first, each with its fix:

| Check | Fix |
|---|---|
| `node` | Install Node.js 18+. Until then gates are off and the board is only reachable on dedicated-ref storage. |
| `backlog-cli` | `npm i -g backlog.md` (offer to run it). |
| `shim-on-path` | Restart the session. The plugin puts its routing first on PATH at session start. |
| `ref-worktree` | Checked and restored automatically. If it still fails, report the git error. After moving a repo: `git worktree repair <path>`. |
| `status-classes` | A column has no class: `/backlog-md:setup`, Settings. |
| `status-callbacks` | Show each callback. The user decides; only then `backlog-md trust-callbacks`. |
| `sync` | `/backlog-md:sync`. |
| `board-integrity` | Duplicate IDs. Explain that repair renames task IDs and that references elsewhere may need updating. With the user's consent run `backlog-md doctor --fix`. Report what changed. |

If `--audit` is given, also run `backlog-md audit`, and list tasks that don't meet the rules for their current status. These usually came from the web UI or a terminal, where gates don't apply. Report them; change nothing unless asked.
