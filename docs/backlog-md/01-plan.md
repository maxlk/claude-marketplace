# Plan: `backlog-md` Claude Code plugin (Backlog.md v1.55.3, Claude Code 2.1.319)

Facts and spec: see 00-research-brief.md. Unofficial plugin; name `backlog-md`, skills are `/backlog-md:<x>`.

## 1. Deep analysis: decisions and why

| # | Question | Decision | Reason / evidence |
|---|---|---|---|
| D1 | How does the agent reach the right board? | A `bin/backlog` **shim shadowing the real CLI**, plus `bin/backlog-md` admin CLI. SessionStart appends `export PATH="<plugin>/bin:$PATH"` to `CLAUDE_ENV_FILE`. | SPIKE: plugin bin/ is added AFTER user PATH so a real install wins without the prepend; with env-file prepend the shim wins in Bash and in subagents. Shim sees post-shell argv (no shell parsing). Agents following upstream docs just type `backlog`. Beats differently named `bl`. |
| D2 | Enforcement of mandatory fields (absent upstream) | Gates in shim (pre-write, real argv, merged post-edit state) + Stop audit of tasks touched this session. No command-string parsing for enforcement. | Shell parsing fails on vars/heredocs. Humans/terminal not affected (shim only on Claude's PATH). |
| D3 | CLI vs MCP | CLI only; no `.mcp.json`. Init uses `--integration-mode none`. | Plugin MCP starts in every project, 24 schemas, second write path; upstream recommends CLI. PostToolUse ledgers a user's own backlog MCP writes so Stop audit still applies. |
| D4 | Dedicated ref implementation | Normal branch `backlog` (name configurable) w/o shared history, worktree at `<git-common-dir>/backlog-wt`, `git worktree lock`ed. Root commit created by plumbing (`mktree`/`commit-tree`/`update-ref`), avoiding unborn branch and `--orphan` (git 2.42). | SPIKES: works w/ BACKLOG_CWD; main checkout stays clean; linked worktrees share one board; clone re-attach works. Hidden refs/* need manual update-ref and refspecs, no web view. |
| D5 | Who commits? | `auto_commit: false`; plugin batches at Stop/SessionEnd with `-c core.hooksPath=/dev/null -c commit.gpgsign=false`, per-user opt `sign: inherit`. Only for plugin-owned boards. | upstream auto_commit can hang on signing, noisy history. In-tree/existing boards: plugin never commits. |
| D6 | Where does config live? | **Team policy**: `<backlogDir>/plugin-policy.json` on the board (SPIKE: survives `saveConfig`, ignored by doctor/lists). **Per-clone state**: `<git-common-dir>/backlog-md/state.json`; non-git: `${XDG_STATE_HOME:-~/.local/state}/backlog-md/<encoded-path>/state.json`. Optional committed `.claude/backlog-md.json` written ONLY for non-default sharing (custom branch name, shared repo URL). | config.yml loses unknown keys. Common-dir state is shared by linked worktrees and survives plugin reinstall; one code path for git/non-git. |
| D7 | Implementation language | POSIX `sh` gate → zero-dep Node ≥18 `.mjs`. Without Node: pass through; doctor reports enforcement off. | Fast no-op in unconfigured projects (plugin is global). YAML/JSON logic impractical in sh. |
| D8 | First-run mechanism | SessionStart `additionalContext` tells Claude to ask one gate question, then run `setup` skill (AskUserQuestion). Hooks can't ask. Written `offeredAt` first; no repeat <24h. | Docs: no install/activate event. |
| D9 | Human approval steps | `backlog-md approve <id>` and `backlog-md trust`: PreToolUse returns `permissionDecision: ask`, so a real human prompt occurs. Shim refuses gated transition/`onStatusChange` without a recorded approval. | Only human-confirmation primitive available to plugin. Bypass mode weakens this; documented. |

## 2. Layout
```
backlog-md/                       (this marketplace repository)
  .claude-plugin/marketplace.json
  README.md, LICENSE, package.json (test script)
  plugins/backlog-md/
    .claude-plugin/plugin.json    (userConfig: offerSetup auto|manual)
    bin/backlog, bin/backlog-md   (sh -> node)
    hooks/hooks.json, hooks/gate.sh
    lib/  env.mjs state.mjs board.mjs config-yaml.mjs policy.mjs argv.mjs real-cli.mjs shim.mjs admin.mjs setup.mjs sync.mjs snapshot.mjs ledger.mjs scan.mjs hook-*.mjs
    presets/columns.json, fields.json
    skills/{setup,workflow,start,finish,next,plan-to-tasks,status,doctor,sync}/SKILL.md
    agents/backlog-planner.md
  tests/  (node:test; unit + e2e against real CLI in temp repos)
  guide/index.html                (interactive guide; also published as Artifact)
```

## 3. Storage modes (setup Q1)
Options shown: 1 Dedicated git ref (Recommended; hidden if not git) · 2 New separate folder · 3 Existing board · 4 More options → follow-up: In-tree tracked (`backlog/` on code branches) · Local-only (`.backlog/` via `.git/info/exclude`) · Shared board repo (git URL, cloned to `~/.local/share/backlog-md/boards/<slug>`). Free-text "Other" is interpreted by the skill.
| mode | boardRoot | plugin commits? | sync |
|---|---|---|---|
| ref | `<common>/backlog-wt` | yes | auto/manual |
| folder | user path (default `~/.local/share/backlog-md/boards/<repo>`), `git init` | yes | manual (no remote) |
| repo | clone dir | yes | auto/manual |
| existing | given path | no | n/a |
| in-tree | project root | no (user's history) | n/a |
| local | project root, `.backlog` | no | n/a |
Existing `backlog` branch containing a board → ref attach path, no re-init. Rejected: submodule, hidden ref.

## 4. Setup flow (`skills/setup`, engine `backlog-md setup`)
Detection (hook; files + local git only, no network, no backlog CLI): skip if source≠startup, agent_id present, CI set, CLAUDE_CODE_SESSION_ATTENDED=0, `never`, snoozed, offered<24h, or plugin option manual. Non-git: offer only if a board exists in cwd. Teammate case: `refs/remotes/origin/<branch>:backlog/plugin-policy.json` exists but no worktree → gate "Attach board (Recommended)/Not now/Never"; never prompts for presets. Board w/o policy → existing-board flow.
Screens: (0) gate Set up/Not now(14d)/Never. (1) one AskUserQuestion with 4 questions: storage, columns, fields, secondary (Recommended/Customize). (2) Optional: follow-ups for More/Customize (prefix, enforcement, sync). (3) Preview exact writes (`backlog-md setup --dry-run`), Apply/Change/Cancel. CLI missing → install question first.
Engine: receives JSON spec on stdin; idempotent; steps: preflight → git plumbing → worktree + lock → `backlog init` (via BACKLOG_CWD, `--integration-mode none --check-branches false --include-remote false --auto-open-browser false`) → YAML edits (line replace; verify with `backlog config get`) → policy → `.gitignore` (`backlog/.locks/`) → commit → write state.json LAST. Failure rolls back what this run created.
Existing boards: never rewrite statuses. Infer classes: last = terminal; default_status and names matching backlog|to do|todo|ready|triage|queued|questions = queued; rest active; user confirms (Use mapping/Adjust/Replace with preset [requires per-status migration]). Labels unioned.
Re-run (`/backlog-md:setup` when configured): multi-select Columns/Field rules/Settings. Removing a column requires mapping affected tasks. Moving storage between modes = out of v1, documented manual steps.
Validation: statuses unique, ≥2, no `Draft`, no commas.

## 5. Presets
Columns (queued | active | terminal; Draft never a column):
- Minimal: To Do | In Progress | Done
- Standard (Recommended): Backlog, To Do | In Progress | Done
- Review-gated: Backlog, To Do | In Progress, In Review | Done
- Agent-driven: Backlog, Ready for Agent | Agent Working, Human Review | Done (`transitions:[{to:"class:terminal",approval:"human"}]`)
- Release/QA: Backlog, To Do | In Progress, In Review, QA, Ready to Release | Done
- Research: Questions | Investigating, Synthesizing, Peer Review | Done

Fields (cumulative gates, stage = create / start / finish). `reporter` excluded: no CLI flag.
- None: off.
- Light: description | - | AC checked. warn.
- Agent-ready (Recommended): description, AC≥1 | plan, assignee | AC+DoD checked, final summary. warn/warn/block.
- Milestone-driven: description, milestone exists | assignee, AC≥1 | AC checked, final summary. warn/warn/block.
- Team: description, AC≥2, priority, type, labels⊂allowed | assignee, milestone exists, plan | AC+DoD checked, final summary. warn/warn/block.
- Strict: Team + milestone at create | same | + notes, modifiedFiles≥1 when type≠docs/spike, references≥1. block.
Rule ops: present, minCount, maxCount, allChecked, in, subsetOf; `source` (milestones, config.labels, config.priorities, config.types, config.projects) or `values`; `when:{field:value}`/`whenNot`; `level`, `message`. Policy stores EXPANDED rules so plugin updates don't change team behaviour. Defaults: DoD per preset (tests pass, lint/typecheck, no unrelated changes; Team+peer review, docs; Strict+risk/rollback). Labels bug, feature, chore, docs (Strict+security, compliance; Research: question, experiment, finding, decision).

## 6. Shim (`bin/backlog`)
1. Resolve real CLI: walk PATH skipping own dir (realpath); cached version check (≥1.55.3 warn); missing → exit 127 with install options.
2. Resolve state from cwd. Unconfigured → exec real, transparent. Configured → set BACKLOG_CWD=boardRoot, always (defeats ancestor match).
3. Interactive/long-running (`browser`, `--watch`, `mcp`, TTY-only) → stdio inherit. Others → pipe, 30s timeout, replay stdout/stderr (closed-stderr hang).
4. `backlog init` in a configured project: refused.
5. `task create`/`task edit` (`-s`, flags table; unknown flag → skip gate, fail open): build merged state (create: from argv + DoD defaults; edit: `task view --json` + argv deltas including `--check-ac`, `--plan`, ...). Evaluate gates for class of target status only when status changes (create: cumulative to initial class); also block clearing required field. block → exit 1, stderr lists missing items, flags, allowed values; warn → run, stderr. `--draft` exempt. Unknown milestone always rejected at create/edit when rule or policy `strictMilestones` (default true).
6. Transition approval; `onStatusChange` refusal unless trusted (sha256 of value).
7. Literal `\n` → newline only when arg has no real newline, stderr note.
8. Retry "being modified by another process" 5x with jitter.
9. Pull-before-create when sync=auto: debounced 60s, 3s cap.
10. Record touched ID in ledger `<state>/sessions/$CLAUDE_CODE_SESSION_ID.json` (SPIKE: var present in Bash incl subagents). Terminal-started without var → no ledger.
`BACKLOG_MD_BYPASS=1` raw passthrough for human use.

## 7. Hooks (all fail open; `gate.sh` exits silently if no state.json, except SessionStart)
| Event | Matcher | Does | Budget |
|---|---|---|---|
| SessionStart | startup,resume,clear,compact | PATH export always. Configured: self-heal worktree (`worktree add`/`repair`), sweep-commit, detached pull, snapshot ≤1500 chars (counts, active tasks, rules, sanitized fenced titles). compact: rules+active only. Unconfigured: offer logic. | 3s |
| PreToolUse | Bash | deny bypasses (`npx backlog.md`, absolute/node_modules path to `backlog`, BACKLOG_MD_BYPASS). `ask` on approve/trust. Auto-allow quote-aware-scanned simple `backlog`/`backlog-md` commands. | 1s |
| PreToolUse | Edit,Write,MultiEdit | deny writes into board tasks/drafts/archive/milestones, ask on config.yml and plugin-policy.json | 1s |
| PostToolUse | `mcp__.*backlog.*__task_(create|edit)` | ledger touched ID | 1s |
| UserPromptSubmit | - | drain one-shot reminder file; sh-only when none | 200ms |
| Stop | - | if not stop_hook_active: audit ledger; block once w/ repair commands (max 2 per violation set). Commit dirty board; debounced push (detached). If code files changed + ledger empty: queue a one-shot reminder | 5s |
| SessionEnd | - | Detached child: commit + push + delete ledger | <1.5s |
Skipped: PostCompact (SessionStart compact), SubagentStop (ledger not per agent), WorktreeCreate, TaskCreated/Completed (Claude's own tasks), CwdChanged (shim resolves per call).

## 8. Sync (`backlog-md sync`, plugin-owned boards only)
Commit under `mkdir` lock (stale 60s); message `chore(backlog): update <ids> [skip ci]`; identity fallback. Pull: explicit-refspec fetch, GIT_TERMINAL_PROMPT=0, 3-10s kill. ff → `merge --ff-only`; diverged → `git merge-tree --write-tree` (needs 2.38; else mark manual): clean → `commit-tree` 2 parents, ff; then `backlog doctor`; duplicates → `--fix --yes`, commit, report remap once. Conflict → never touch live tree; `sync.blocked` set; keep local commits; surfaced in SessionStart/Stop; resolve via `backlog-md sync --resolve ours|theirs` (`git merge -X`). Push: `--no-verify`, explicit refspec, never force; debounce 5 min; rejected non-ff → pull then retry 3x; ruleset rejection → blocked with hint. Setup asks before enabling push, shows exact remote/branch, warns the branch is as visible as the repo. Pull flags new `onStatusChange` (see shim).

## 9. Skills / agent
Model-invocable: `workflow` (plugin deltas; defers to `backlog instructions <topic>`), `start`, `finish`, `next`, `plan-to-tasks`, `setup` (narrow description: only after the offer or on request). User-only (`disable-model-invocation`): `status`, `doctor`, `sync`. Each has `allowed-tools: Bash(backlog *), Bash(backlog-md *)`, etc. Agent `backlog-planner`: read-only + Bash, capped turns, decomposes specs to tasks.
Active task: `start` (entering active records in ledger); fallback branch name `task-12-*`. Snapshot shows it. Prompt injection: only IDs/status/priority/sanitized titles enter context (control chars/newlines stripped, 80 chars, fenced as untrusted, closing tags neutralized).

## 10. Verification
- `claude plugin validate --strict`.
- Unit: argv, gates, scan, yaml edit, sanitization.
- E2E on real CLI in temp repos: each storage mode; clone re-attach; custom presets; gates block/warn/approve; concurrent edits retry; diverged merge; conflict blocked; duplicate ID repair; unconfigured passthrough; hooks fed JSON.
- `claude -p --plugin-dir` smoke: shim wins, gate blocks missing fields, Stop commits.
- Measure gate.sh no-op latency.

## 11. Deliverables
Plugin repo (no git commit unless requested); interactive HTML guide published as a private Artifact, copy at guide/index.html.

## 12. Out of scope v1
Storage migration between modes (documented manual steps), custom fields (unknown frontmatter not in JSON), MCP write gating at pre-write, Windows.
