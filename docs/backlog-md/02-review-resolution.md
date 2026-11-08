# Review resolution (overrides 01-plan.md where they differ)

Accepted:
- onStatusChange: raw frontmatter + config check in shim, fail CLOSED on any status change; never auto-run untrusted callback. `backlog-md trust-callbacks` (hook `ask`).
- Gate `draft promote`; normalize `task|tasks`; `-s Draft` = draft. Promoted ID by diffing tasks/.
- Setup: storage FIRST, then branch; columns only for new boards; max 3 presets + "More".
- Terminal access: `backlog-md shell-init` prints `blg` function; status --web background browser.
- Milestone presets: setup asks first milestone; compare ID + title via files.
- default_status always written, must be a member of statuses.
- Stop no longer commits every turn: commit debounced (10 min) at Stop, always at SessionEnd, sweep at SessionStart. Stop blocks only on terminal-status block-level violations.
- Sync: commit before pull; ls-remote in preflight; divergence with unrelated histories => blocked. Commit IDs from staged diff.
- Collisions (refs/heads/backlog/*, existing non-board branch) preflighted, skill offers another name.
- Full argv model: --flag=v, -s"x", interleaved IDs, case-insensitive status, per-ID gates, pre-validate all IDs, unknown flag + status change => refuse.
- core.hooksPath override on ALL plugin git calls; disclosed in setup preview.
- boardRoot derived per call for ref/local/in-tree (linked worktrees, repo moves); `git worktree repair <path>` in heal.
- Retry backoff ~5s. `fork` SessionStart source. Offer: count (max 3 unanswered), set when answered. Non-git offered except $HOME/tmp.
- Path quoting; no-Node fallback sets BACKLOG_CWD for ref mode; `bin/` limit noted for claude.ai/Cowork.

Adjusted:
- Auto-allow: keep simple `task create/edit` (autoApprove default "writes", option "reads"/"off") because shim guard is fail-closed; scanner quote-aware. Only when session-start wrote the ledger (proves shim on PATH).
- Approval: keep `ask` as a guardrail, documented as NOT a security boundary. Evasions (`sh -c`) are not auto-allowed so they hit a normal prompt.
- Keep clean merge via merge-tree (concurrent creates = routine). Cut `--resolve`: conflicts handled in the skill with git in the board worktree, `sync --unblock`; Edit guard lifted while blocked. Duplicate IDs after merge: NOT auto-fixed; surfaced, repair by /doctor with consent.
- Local-only mode: `<common>/backlog-local` with --no-git (shared across linked worktrees).

Cut for v1: BACKLOG_MD_BYPASS, MCP ledger, `\n` rewriting (skill note), `sign: inherit`, backlog-planner agent, shared-repo-URL mode (clone + Existing covers it), `.claude` pointer retained only for custom branch names.
