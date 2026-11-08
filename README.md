# maxlk Claude Code marketplace

Claude Code plugins by maxlk.

## Add this marketplace

```
/plugin marketplace add maxlk/claude-marketplace
```

## Plugins

| Plugin | What it does | Install |
|---|---|---|
| [backlog-md](plugins/backlog-md/README.md) | Track work on a Backlog.md kanban board: guided per-project setup, dedicated-ref storage, required-field gates and board sync. Unofficial. | `/plugin install backlog-md@maxlk` |

## Repository layout

- `.claude-plugin/marketplace.json`: the marketplace catalog.
- `plugins/<name>/`: what gets installed.
- `tests/<name>/`, `docs/<name>/`, `guide/<name>/`: development files, not installed.

## Development

```
BACKLOG_BIN_DIR=/dir/with/backlog npm test
claude plugin validate .
```

`BACKLOG_BIN_DIR` is only needed when the Backlog.md CLI isn't on your `PATH`.

## License

MIT
