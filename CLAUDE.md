# maxlk Claude Code marketplace

Claude Code plugins, distributed from this repo as marketplace `maxlk`. There is currently one plugin, `backlog-md`, which integrates the Backlog.md CLI.

## Commands

```
npm test                          # all plugin tests; needs the real Backlog.md CLI
claude plugin validate .          # marketplace manifest
claude plugin validate plugins/backlog-md
claude --plugin-dir plugins/backlog-md   # try local changes for one session
```

The e2e tests need the real CLI (`npm i -g backlog.md`, 1.55.3+). The plugin's own `bin/backlog` wrapper doesn't count and is skipped when looking for it, so 29 of the 42 tests fail without the real one. To use a copy that isn't on `PATH`, set `BACKLOG_BIN_DIR=/dir/containing/backlog`.

Run one test: `node --test --test-name-pattern="<name>" tests/backlog-md/e2e.test.mjs`.

## Layout rules

- `plugins/<name>/` is exactly what gets installed. Tests, design notes and guides go in `tests/<name>/`, `docs/<name>/` and `guide/<name>/`.
- Don't add a `CLAUDE.md` inside a plugin: it isn't loaded and the validator warns. Put plugin notes here.
- A new plugin needs an entry in `.claude-plugin/marketplace.json` with `source: "./plugins/<name>"`, and a row in `README.md`.

## Releasing

Users stay on the installed version until `version` changes, so a fix isn't delivered until it's bumped.

1. Bump `version` in `plugins/<name>/.claude-plugin/plugin.json`. Don't also set it in `marketplace.json`.
2. Commit and push to `main`.
3. Optional: `claude plugin tag plugins/<name> --push`.

## backlog-md

Zero-dependency Node 18+ (`.mjs`) behind POSIX `sh` entry points. macOS and Linux, so no `timeout`, `flock` or other GNU-only tools in shell or spawned commands. `docs/backlog-md/` records why the design is what it is; `02-review-resolution.md` overrides the plan where they differ.

How it fits together:

- `bin/backlog` (`lib/shim.mjs`) shadows the real CLI for Claude only. It resolves the board per call, sets `BACKLOG_CWD`, and evaluates required-field gates on real argv before writing.
- `bin/backlog-md` (`lib/admin.mjs`) holds setup, diagnostics and consent commands. Skills only gather choices and call it; deterministic logic belongs in `lib/`, not in `SKILL.md`.
- `hooks/gate.sh` exits early in projects with no board, then hands off to `lib/hook.mjs`. Plugins are enabled everywhere, so keep that no-op path cheap.
- Team policy lives on the board in `plugin-policy.json`. Per-clone state lives in `<git-common-dir>/backlog-md/` (`state.json`, `runtime.json`, `sessions/`).

Rules that are easy to break:

- **PATH:** Claude Code adds plugin `bin/` after the user's `PATH`, so a real `backlog` would win. The SessionStart hook prepends it through `CLAUDE_ENV_FILE`, which only takes effect from the next session.
- **Failure direction:** hooks fail open. The `onStatusChange` check in the shim fails closed, because Backlog.md runs those callbacks through a shell and a pulled board can contain them. It reads raw frontmatter since `--json` omits the field.
- **Enforcement location:** gates belong in the shim, which sees parsed argv. `lib/scan.mjs` only decides whether to skip a permission prompt, so don't build enforcement on command-string parsing.
- **git:** use `git()` from `lib/common.mjs`, which disables repo hooks and terminal prompts. Plugin commits happen only on boards it owns (`ref` and `folder` modes). Never force-push or put conflict markers in the live board.
- **Backlog.md CLI:** run it with stderr piped, because it can hang on a closed stderr. Unknown keys in `config.yml` are lost when it rewrites the file, and list keys like `statuses` can't be set through `backlog config set`; `lib/board.mjs` edits them directly.
- **Untrusted text:** task titles and bodies are data. Anything added to Claude's context goes through `sanitizeTitle` and stays inside the `untrusted-board-data` fence.
- **New CLI flags:** add them to the spec tables in `lib/argv.mjs` and to `editModel`/`createModel`. Unknown flags make the shim refuse status changes.

Testing: e2e tests use real git and the real CLI in temporary directories. Add one for any change to gates, sync or setup. Headless runs can't exercise the interactive `/backlog-md:setup` questions, so check those by hand.

`guide/backlog-md/index.html` is a standalone page with an inline copy of the presets in `const PRESETS`. Update it when `presets/*.json` change.
