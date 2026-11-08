# Research brief: Backlog.md Claude Code plugin

## User's goal (verbatim requirements)
Reusable Claude Code plugin for tracking work with Backlog.md.
- When activated in a specific project, ask where to store the backlog: dedicated ref in the current git repo (DEFAULT); a new separate folder; use existing board; other (brainstorm other options).
- If the board is new, initialization suggests choosing among kanban column presets.
- Project setup asks if `milestone` or other fields are mandatory; ideally suggests presets of mandatory fields (brainstorm a few).
- Include everything required for efficient and reliable Backlog.md + Claude Code integration: hooks, skills, etc.
- Final deliverable also includes an interactive HTML guide for the plugin user.

## Backlog.md v1.55.3 (verified from source + run locally; CLI at scratchpad/tool/node_modules/.bin/backlog)
Install: npm i -g backlog.md | bun add -g | brew install backlog-md | `npx backlog.md <cmd>` (`npx backlog` is an unrelated package). npm bin is a Node shim over a platform binary.

### init
`backlog init [name]` flags: --defaults --no-git --agent-instructions (claude,agents,gemini,copilot,cursor,none) --integration-mode cli|mcp|none --install-claude-agent --backlog-dir <project-relative> --config-location folder|root --task-prefix <letters> --check-branches --include-remote --branch-days --bypass-git-hooks --zero-padded-ids --default-editor --web-port --auto-open-browser.
Any flag = non-interactive. No TTY + no git + no --no-git = exit 1. `--integration-mode none` cannot be combined with --agent-instructions. Re-init preserves config. Creates backlog/{tasks,drafts,archive/{tasks,drafts,milestones},milestones,docs,decisions,config.yml}. Non-interactive default writes an AGENTS.md nudge unless integration none.

### config
On-disk keys: project_name, default_assignee, default_reporter, default_status, statuses, labels, types, priorities, projects, definition_of_done, date_format, max_column_width, default_editor, auto_open_browser, hide_empty_columns, default_port, remote_operations, auto_commit, filesystem_only, zero_padded_ids, bypass_git_hooks, check_active_branches, active_branch_days, onStatusChange, task_prefix, backlog_directory.
`milestones` deprecated (milestones are files via `backlog milestone add`).
`saveConfig` rebuilds the file from known keys: unknown keys and comments are LOST on any write. So plugin metadata can't live in backlog config.yml.
`config set` keys: defaultEditor, projectName, defaultAssignee, defaultStatus, dateFormat, maxColumnWidth, autoOpenBrowser, hideEmptyColumns, defaultPort, remoteOperations, autoCommit, filesystemOnly, bypassGitHooks, zeroPaddedIds, checkActiveBranches, activeBranchDays.
`statuses, labels, types, priorities, projects, definitionOfDone` are NOT settable via CLI: must edit YAML (flow arrays, verified it works by regex replace of a line). MCP has `definition_of_done_defaults_upsert`.
Mandatory fields: NO mechanism; only title required. No custom fields in schema (unknown frontmatter is preserved on edit since 1.55.0 but not exposed via --json).

### location / root resolution
Options: backlog/, .backlog/, custom project-relative (needs root backlog.config.yml). Absolute and `..` rejected; symlink out accepted.
`BACKLOG_CWD` env applies to EVERY command including init. `--cwd` only on `mcp start`.
findBacklogRoot walks up to a directory with config, then falls back to git toplevel; can match an unrelated ancestor.
auto_commit default false. Commits go to the repo owning the file. Git operates on the working tree/current branch.
Cross-branch scan (check_active_branches) does `git fetch origin --prune` on ID allocation: slow; disable via check_active_branches: false / remote_operations: false.
Sequential IDs collide across clones; `backlog doctor --fix` repairs. Duplicates make `task list`/`search` exit 1 with empty stdout (#1146).
Locks: `.locks/` under backlog dir; task locks 0 retries so concurrent edits fail immediately; create lock waits 30s. Unverified whether .locks is gitignored.
`--milestone X` with an unknown milestone is silently accepted (verified by run) - virtual milestone.
`onStatusChange` config runs shell commands, including per-task frontmatter (security note).
`\n` in args stays literal; need real newlines.
Hang when stderr is closed pipe and >4KiB written (#1048).

### EXPERIMENTS RUN LOCALLY (all succeeded)
1. `git worktree add --orphan -b backlog .git/backlog-wt` then `backlog init "Exp" --defaults --integration-mode none --check-branches false --include-remote false --auto-open-browser false` inside it. Creates backlog/ in the worktree. Note: branch has NO commits until the first commit; `git log` there errors.
2. From main checkout with `BACKLOG_CWD=<repo>/.git/backlog-wt`, `backlog task create/list/view/edit` all work, incl. from a subdir. Main checkout `git status` stays clean. `backlog` without the env says "No Backlog.md project found", rc=1.
3. Works with linked worktrees: `git rev-parse --git-common-dir` from a linked worktree returns the main .git, so one shared board for all worktrees. `git worktree list` shows the board worktree.
4. Fresh clone: `git worktree add .git/backlog-wt -b backlog --track origin/backlog` restores the board.
5. Non-branch ref (refs/board/main) can be checked out `--detach` but requires manual update-ref after each commit and explicit refspecs for push/fetch.
6. Custom statuses via YAML edit: works. Invalid status rc=1 with error. Tasks whose status isn't in config still listed. Plan/notes accepted for any non-first status.
7. `task list --json`, `task view <id> --json` give schemaVersion:1 envelopes incl. id,title,status,type,priority,project,assignees,reporter,labels,milestone,parentTaskId,acceptanceCriteriaCompleted/Count,references,modifiedFiles,ordinal,createdAt,updatedAt,dueDate,isReady; view adds path,description,dependencies,dependencyGraph,readiness,documentation,subtasks,acceptanceCriteria[],definitionOfDone[{index,text,checked}]. (Whether plan/notes/finalSummary are in view JSON: check.)
8. `backlog board` rejects --plain. `backlog instructions [overview|task-creation|task-execution|task-finalization]` prints workflow guides.
9. MCP server 24 tools; `backlog mcp start --cwd <dir>` pins root. Without pin, wrong-checkout bugs. Tools: task_create, task_list, task_search, task_edit, task_view, task_archive, task_delete, task_restore, milestone_*, definition_of_done_defaults_*, document_*, get_backlog_instructions.
Upstream now recommends CLI integration over MCP ("cli instructions are recommended").
Exit codes: 0 or 1 only.

Task file: backlog/tasks/task-1 - Title.md; YAML frontmatter (id,title,status,assignee,reporter,created_date,updated_date,due_date,labels,milestone,dependencies,references,documentation,modified_files,parent_task_id,subtasks,priority,type,project,ordinal,onStatusChange); body markers SECTION:{DESCRIPTION,PLAN,NOTES,FINAL_SUMMARY}, AC:BEGIN/END, DOD:BEGIN/END, COMMENTS.

## Claude Code plugin spec (official docs, Claude Code 2.1.319)
Layout: .claude-plugin/plugin.json (only `name` required; userConfig available), skills/<n>/SKILL.md, commands/, agents/*.md, hooks/hooks.json, .mcp.json, bin/ (added to Bash PATH; bare commands), settings.json (only `agent`/`subagentStatusLine` honored), monitors/. marketplace at .claude-plugin/marketplace.json. Test: `claude plugin validate <path> [--strict]`, `claude --plugin-dir <path>`.
Skills: `/plugin:dir`. Frontmatter name, description, when_to_use, argument-hint, disable-model-invocation, user-invocable, allowed-tools (grants per-turn, no restriction; `Bash(...)` rules can use ${CLAUDE_PLUGIN_ROOT}), model, effort, context: fork, agent, hooks, paths. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` substituted in plugin skill bodies; NOT exported to the Bash tool env.
Hooks events: SessionStart(startup|resume|clear|compact|fork), Setup, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PostToolBatch, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, PreCompact/PostCompact, CwdChanged, FileChanged, WorktreeCreate/Remove, SessionEnd, ...
stdin: session_id, transcript_path, cwd, permission_mode, hook_event_name, agent_id/agent_type; tool_name/tool_input/tool_use_id (+tool_response on Post); source on SessionStart; stop_hook_active on Stop.
Output: exit 2 = blocking + stderr; JSON: systemMessage (shown to user), decision:block+reason (UserPromptSubmit, PostToolUse, Stop, SubagentStop...), hookSpecificOutput{hookEventName, additionalContext (<=10k chars), permissionDecision allow|deny|ask|defer, permissionDecisionReason, updatedInput}. PreToolUse can `updatedInput` to rewrite a command. Deny rules still win over a hook's allow.
Env: CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_OPTION_<KEY>, CLAUDE_ENV_FILE (SessionStart, Setup, CwdChanged, FileChanged; append export lines; persists to Bash).
Timeouts: command 600s default; SessionEnd budget 1.5s default (raise per-hook up to 60s, plugin hook timeouts do not raise the budget). Stop-hook 8-consecutive continuation cap.
No install/first-activation event. Hooks can't ask the user. Recommended first-run: SessionStart additionalContext -> tells Claude to run a setup skill -> skill uses AskUserQuestion. Marker in project or ${CLAUDE_PLUGIN_DATA}.
Plugins can't ship permissions.allow. To reduce prompts: skill allowed-tools (per-turn), PreToolUse permissionDecision:"allow" for matching commands, plugin bin/ on PATH, users add own rules.
Agents in plugins: agents/*.md; frontmatter name, description, model, effort, maxTurns, tools, disallowedTools, skills, memory, background, isolation; no hooks/mcpServers/permissionMode.
MCP in plugin: .mcp.json at root, starts when plugin enabled in every project; ${CLAUDE_PROJECT_DIR} etc. substituted; no conditional start (wrapper exits early). Tool names mcp__plugin_<plugin>_<server>__<tool>.
Available environment: node 24, jq, python3 (macOS system), git; bun absent. Plugin must be portable across macOS/Linux.
