---
name: setup
description: Set up or reconfigure this project's Backlog.md board. Use only when the user runs it or agrees to set up the board after the plugin's offer.
argument-hint: "[--defaults]"
allowed-tools: Bash(backlog-md *), Bash(npm i -g backlog.md), AskUserQuestion
---

# Set up a Backlog.md board

You gather choices with AskUserQuestion; `backlog-md setup` applies them. Keep it short: one screen per step, recommended option first. Pass specs with `--spec '<json>'`.

## 1. Inspect
Run `backlog-md detect`. If `cli.path` is null or `cli.ok` is false, ask whether to install or upgrade with `npm i -g backlog.md`, then detect again. If they decline, stop and explain the plugin needs the CLI.

Branch on the result:
- `configured: true` → go to **Reconfigure**.
- The plugin offered an attach flow, or `backlogBranch` shows a remote or local `backlog` branch → dry-run `{"mode":"ref"}`. If it reports `attach: true`, a shared board exists: ask only about **Sync** and **Apply**. If it reports a `branch_collision`, continue normally.
- Otherwise continue.

`--defaults` skips questions: `ref` storage when in git (otherwise `folder`), `standard` columns, `agent-ready` fields, sync manual.

## 2. Storage (always ask first, by itself)
Ask "Where should this project's backlog live?":
1. **Dedicated git ref (Recommended)** — a `backlog` branch with no shared history, checked out inside `.git`. Code branches and PRs stay free of task files; every worktree shares one board. Omit if `git` is false.
2. **New separate folder** — a new board in its own folder. Default path `~/.local/share/backlog-md/boards/<project>`; ask for another path if they want one.
3. **Existing board** — ask for the path to a folder holding a board.
4. **More options** — ask a follow-up:
   - **In the code tree** (`in-tree`): `backlog/` tracked with your code, so tasks travel with branches and PRs. Noisy diffs; you commit it yourself.
   - **Private to this clone** (`local`): kept inside `.git`, never versioned or shared. No backup.

Treat free-text "Other" as a request to map onto these modes. A board shared by several repositories: clone it, then use **Existing board**. If nothing fits, explain the limits and re-ask.

Mode values: `ref`, `folder`, `existing`, `in-tree`, `local`. Run `backlog-md setup --dry-run --spec '{"mode":"ref"}'` before going on.
- `branch_collision` error: ask for another branch name (suggest `kanban` or `project-board`) and pass `"branch"`.
- `attach: true`: this board already exists. Skip Columns. For a board with a policy, skip Fields as well.
- `existing` result includes `detected`. Show its statuses grouped as queued / active / terminal and ask: **Use this mapping (Recommended)** / **Adjust**. Pass adjusted values as `"classes"`. Never rewrite an existing board's columns here. If `detected.hasPolicy` is true, skip Fields.

## 3. New board: columns and fields (one AskUserQuestion, two questions)
Use `backlog-md presets` for the exact statuses, and put them in each option's description.

**Which kanban columns?** Standard (Recommended) · Review-gated · Agent-driven · More → follow-up: Minimal, Release / QA, Research. "Other": a typed list becomes `{"statuses":[...]}` with at least 2 unique names, no `Draft`, the last one terminal.

**Which fields are mandatory?** Agent-ready (Recommended) · Light · Milestone-driven · More → follow-up: Team, Strict / Audit, None. Explain that requirements apply at three moments (create, start, finish) and that Milestone-driven makes `milestone` mandatory from creation. "Other": ask which fields and at which stage, then pass `{"enforcement":"warn","gates":{"create":[{"field":"milestone","op":"in","source":"milestones"}]}}`. Field names and operators: see `references` in the `backlog-md:workflow` skill.

For a board that exists but has no policy, ask only the fields question.

If the preset has `requiresMilestone`, ask for the first milestone's name (suggest "V1") and pass `"milestones":["V1"]`.

## 4. Sync (only if `origin` exists and mode is `ref`)
Ask, naming the actual remote from `detect.origin`: **Sync automatically (Recommended)** / **Manual only**. Warn that the board branch is as visible as the repository, so task text becomes readable to anyone with access. Pass `"sync":"auto"` or `"manual"`.

## 5. Review and apply
Run `backlog-md setup --dry-run --spec '<full spec>'` and show `actions` and `notes` as a short list. Tell the user that board commits skip repository git hooks and signing. Ask **Apply (Recommended)** / **Change something** / **Cancel**.

On Apply: `backlog-md setup --spec '<full spec>'`. On `milestone_required` go back to the milestone question; report other `errors` plainly.

## 6. Finish
Report mode, location, columns and required fields. Mention `/backlog-md:status`. For `ref`, `folder`, `local` or `existing` boards, the user's own terminal needs a helper because the plugin's routing only applies inside Claude: run `backlog-md shell-init` and show the line to add to their shell profile.

## Reconfigure
Ask (multi-select) what to change: **Columns**, **Required fields**, **Settings** (enforcement off/warn/block, sync, auto-approve writes/reads/off). Apply with `backlog-md reconfigure --spec '<json>'`, keys `columns`, `statusMap`, `classes`, `fields`, `enforcement`, `sync`, `autoApprove`, `milestones`.

If the result has `status_mapping_required`, show `affected` tasks and ask where each removed status should go, as `"statusMap":{"Old":"New"}`. Moving a board between storage modes isn't automated: point the user to the README's "Moving a board" section.
