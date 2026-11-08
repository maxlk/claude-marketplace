// Entry point behind bin/backlog-md: setup, diagnostics and consent commands.
import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIR, exists, git, realpath, run, shellQuote } from './common.mjs';
import { boardPaths, boardRoot, cliVersion, findBacklogDir, findRealCli, isConfigured, loadPolicy, readRuntime, resolveContext, saveState, versionOk, MIN } from './context-exports.mjs';
import { allCallbacks, hashCallback, listTasks, loadMilestones, readConfig, viewTask } from './board.mjs';
import { classOf, evaluate, stagesFor, summarizePolicy } from './policy.mjs';
import { applySetup, COLUMN_PRESETS, dryRun, FIELD_PRESETS, heal, reconfigure, suggestTaskPrefix } from './setup.mjs';
import { commitBoard, pull, push, syncStatus, unblock } from './sync.mjs';

const [, , command, ...args] = process.argv;
const print = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
const die = (m) => {
  process.stderr.write(`[backlog-md] ${m}\n`);
  process.exit(1);
};
const stdinJson = () => {
  const at = args.indexOf('--spec');
  try {
    return JSON.parse(at >= 0 ? args[at + 1] : fs.readFileSync(0, 'utf8'));
  } catch (e) {
    return die(`expected a JSON spec via --spec '<json>' or stdin (${e.message})`);
  }
};
const requireConfigured = () => {
  const ctx = resolveContext();
  if (!isConfigured(ctx)) die('This project has no board configured. Run /backlog-md:setup.');
  return ctx;
};

function detect() {
  const ctx = resolveContext();
  const real = findRealCli();
  const version = cliVersion(real);
  const onPath = run('sh', ['-c', 'command -v backlog']).stdout.trim();
  const out = {
    git: ctx.git,
    bare: ctx.git && !ctx.topLevel,
    projectDir: ctx.projectDir,
    suggestedTaskPrefix: suggestTaskPrefix(path.basename(ctx.projectDir ?? ctx.cwd)),
    configured: isConfigured(ctx),
    state: ctx.state,
    cli: { path: real, version, ok: versionOk(version), minimum: MIN, shimFirst: onPath ? realpath(path.dirname(onPath)) === realpath(BIN_DIR) : false },
    node: process.version,
  };
  if (ctx.git) {
    const origin = git(ctx.cwd, ['remote', 'get-url', 'origin']);
    out.origin = origin.code === 0 ? origin.stdout.trim() : null;
    out.inTreeBoard = ctx.topLevel ? findBacklogDir(ctx.topLevel) : null;
    out.backlogBranch = {
      local: git(ctx.cwd, ['rev-parse', '--verify', '-q', 'refs/heads/backlog']).code === 0,
      remote: git(ctx.cwd, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/backlog']).code === 0,
    };
  }
  print(out);
}

function status() {
  const ctx = requireConfigured();
  const real = findRealCli();
  const p = boardPaths(ctx);
  const policy = loadPolicy(ctx) ?? {};
  const out = { mode: ctx.state.mode, boardRoot: p.root, preset: policy.preset ?? null, rules: summarizePolicy(policy), sync: syncStatus(ctx) };
  if (real) {
    const listed = listTasks(real, { ...process.env, BACKLOG_CWD: p.root });
    if (listed.error) out.boardError = listed.error;
    else {
      out.statuses = (readConfig(p.config).statuses ?? []).map((s) => ({ status: s, tasks: listed.tasks.filter((t) => t.status === s).map((t) => ({ id: t.id, title: t.title, assignees: t.assignees, milestone: t.milestone })) }));
      out.outsideColumns = listed.tasks.filter((t) => !(readConfig(p.config).statuses ?? []).includes(t.status)).map((t) => ({ id: t.id, status: t.status }));
    }
  }
  print(out);
}

// Reports tasks not meeting the rules for their current status, however they
// got there (web UI, terminal, direct edits).
function audit() {
  const ctx = requireConfigured();
  const real = findRealCli();
  if (!real) die('Backlog.md CLI not found.');
  const p = boardPaths(ctx);
  const policy = loadPolicy(ctx);
  if (!policy) die('This board has no plugin-policy.json.');
  const env = { ...process.env, BACKLOG_CWD: p.root };
  const listed = listTasks(real, env);
  if (listed.error) die(listed.error);
  const config = readConfig(p.config);
  const milestones = loadMilestones(p.dir);
  const findings = [];
  for (const t of listed.tasks) {
    const v = viewTask(real, env, t.id);
    if (v.error) continue;
    const found = evaluate(policy, v.task, stagesFor(classOf(policy, t.status)), { config, milestones });
    if (found.length) findings.push({ id: t.id, status: t.status, problems: found.map((f) => f.message) });
  }
  print({ total: listed.tasks.length, violating: findings.length, findings });
}

function doctor() {
  const ctx = resolveContext();
  const fix = args.includes('--fix');
  const real = findRealCli();
  const version = cliVersion(real);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, status: ok === null ? 'info' : ok ? 'ok' : 'fail', detail });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 18, process.version);
  add('backlog-cli', versionOk(version), real ? `${real} (${version})` : 'not found');
  const onPath = run('sh', ['-c', 'command -v backlog']).stdout.trim();
  add('shim-on-path', onPath ? realpath(path.dirname(onPath)) === realpath(BIN_DIR) : false, onPath || 'backlog not on PATH');
  add('configured', isConfigured(ctx), ctx.state?.mode ?? 'not set up');
  if (isConfigured(ctx)) {
    const p = boardPaths(ctx);
    if (ctx.state.mode === 'ref') {
      const h = heal(ctx);
      add('ref-worktree', h.ok, h.repaired ? `restored at ${p.root}` : h.error ?? p.root);
      const locked = git(ctx.cwd, ['worktree', 'list', '--porcelain']).stdout.split('\n\n').find((b) => b.startsWith(`worktree ${p.root}`))?.includes('locked');
      add('ref-worktree-locked', Boolean(locked), locked ? 'protected from prune' : 'run: git worktree lock');
    }
    add('board-root', exists(p.root ?? ''), p.root);
    add('board-config', exists(p.config ?? ''), p.config);
    const policy = loadPolicy(ctx);
    add('policy', Boolean(policy), p.policy);
    if (policy && exists(p.config)) {
      const cfg = readConfig(p.config);
      const unmapped = (cfg.statuses ?? []).filter((s) => !classOf(policy, s));
      add('status-classes', unmapped.length === 0, unmapped.length ? `no class for: ${unmapped.join(', ')}` : 'every column is classified');
      add('default-status', (cfg.statuses ?? []).includes(cfg.default_status), `default_status: ${cfg.default_status}`);
    }
    const untrusted = allCallbacks(ctx).filter((c) => !(ctx.state.trustedCallbacks ?? []).includes(hashCallback(c.value)));
    add('status-callbacks', untrusted.length === 0, untrusted.length ? untrusted.map((c) => `${c.where}: ${c.value}`).join(' | ') : 'none untrusted');
    const rt = readRuntime(ctx);
    add('sync', !rt.blocked, rt.blocked ? `blocked: ${rt.blocked.reason}` : `${ctx.state.sync ?? 'manual'}`);
    if (real) {
      const env = { ...process.env, BACKLOG_CWD: p.root };
      const d = run(real, fix ? ['doctor', '--fix', '--yes'] : ['doctor'], { env, timeout: 30000 });
      add('board-integrity', /No duplicate/i.test(d.stdout) || fix, d.stdout.trim().slice(0, 1200));
      if (fix) {
        commitBoard(ctx);
        saveRuntimeClear(ctx);
      }
    }
  }
  print({ healthy: !checks.some((c) => c.status === 'fail'), checks });
}

function saveRuntimeClear(ctx) {
  const rt = readRuntime(ctx);
  rt.duplicates = false;
  fs.writeFileSync(path.join(ctx.stateDir, 'runtime.json'), `${JSON.stringify(rt, null, 2)}\n`);
}

function sync() {
  const ctx = requireConfigured();
  if (args.includes('--status')) return print(syncStatus(ctx));
  if (args.includes('--unblock')) return print(unblock(ctx));
  const commit = commitBoard(ctx);
  const pulled = pull(ctx, { force: true, timeout: 20000 });
  const pushed = pulled.blocked ? { skipped: true } : push(ctx, { force: true });
  return print({ commit, pull: pulled, push: pushed });
}

function shellInit() {
  const ctx = requireConfigured();
  const fn = (() => {
    if (ctx.state.mode === 'ref') return `BACKLOG_CWD="$(git rev-parse --path-format=absolute --git-common-dir)/backlog-wt" backlog "$@"`;
    if (ctx.state.mode === 'local') return `BACKLOG_CWD="$(git rev-parse --path-format=absolute --git-common-dir)/backlog-local" backlog "$@"`;
    if (ctx.state.mode === 'folder' || ctx.state.mode === 'existing') return `BACKLOG_CWD=${shellQuote(boardRoot(ctx))} backlog "$@"`;
    return 'backlog "$@"';
  })();
  print(`blg() { ${fn}; }`);
}

const COMMANDS = {
  detect,
  status,
  audit,
  doctor,
  sync,
  'shell-init': shellInit,
  presets: () => print({ columns: COLUMN_PRESETS(), fields: FIELD_PRESETS() }),
  policy: () => print(loadPolicy(requireConfigured()) ?? {}),
  setup: () => {
    const spec = stdinJson();
    const result = args.includes('--dry-run') ? dryRun(spec) : applySetup(spec);
    print(result);
    if (result.ok === false || result.errors?.length) process.exitCode = 1;
  },
  reconfigure: () => {
    const r = reconfigure(stdinJson());
    print(r);
    if (!r.ok) process.exitCode = 1;
  },
  snooze: () => {
    const ctx = resolveContext();
    saveState(ctx, { snoozeUntil: Date.now() + 14 * 24 * 3600 * 1000 });
    print('Setup offer snoozed for 14 days. Run /backlog-md:setup at any time.');
  },
  never: () => {
    const ctx = resolveContext();
    saveState(ctx, { never: true });
    print('backlog-md will not offer setup in this project. Run /backlog-md:setup at any time.');
  },
  'reset-offer': () => {
    const ctx = resolveContext();
    saveState(ctx, { never: false, snoozeUntil: 0, offerCount: 0 });
    print('Setup offer reset.');
  },
  approve: () => {
    const ctx = requireConfigured();
    const id = args[0]?.toUpperCase();
    if (!id) die('usage: backlog-md approve <task-id>');
    saveState(ctx, { approvals: { ...(ctx.state.approvals ?? {}), [id]: Date.now() } });
    print(`${id} approved for its next move to a human-gated status.`);
  },
  'trust-callbacks': () => {
    const ctx = requireConfigured();
    const found = allCallbacks(ctx);
    saveState(ctx, { trustedCallbacks: [...new Set([...(ctx.state.trustedCallbacks ?? []), ...found.map((c) => hashCallback(c.value))])] });
    print(found.length ? `Trusted on this clone:\n${found.map((c) => `  ${c.where}: ${c.value}`).join('\n')}` : 'No callbacks on this board.');
  },
};

if (!COMMANDS[command]) die(`unknown command "${command ?? ''}". Commands: ${Object.keys(COMMANDS).join(', ')}`);
COMMANDS[command]();
