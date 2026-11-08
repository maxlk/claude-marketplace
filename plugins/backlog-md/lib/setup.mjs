// Deterministic setup engine. The setup skill gathers choices; this applies them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, git, PLUGIN_ROOT, readJson, realpath, run, writeAtomic, writeJson } from './common.mjs';
import { boardPaths, boardRoot, cliVersion, findBacklogDir, findRealCli, INSTALL_HELP, LOCAL_DIR, REF_WORKTREE, resolveContext, saveState, versionOk } from './context.mjs';
import { allCallbacks, hashCallback, listTasks, readConfig, setConfigKeys } from './board.mjs';
import { commitBoard, commitIdentityEnv } from './sync.mjs';

export const COLUMN_PRESETS = () => readJson(path.join(PLUGIN_ROOT, 'presets', 'columns.json'));
export const FIELD_PRESETS = () => readJson(path.join(PLUGIN_ROOT, 'presets', 'fields.json'));

const QUEUED_NAMES = /^(backlog|to ?do|ready|triage|queued|questions|inbox|icebox|new)\b/i;

export function inferClasses(statuses, defaultStatus) {
  const terminal = statuses.at(-1);
  const queued = statuses.slice(0, -1).filter((s) => s === defaultStatus || QUEUED_NAMES.test(s));
  const active = statuses.slice(0, -1).filter((s) => !queued.includes(s));
  return { queued, active, terminal: [terminal] };
}

export function validateStatuses(statuses) {
  const errors = [];
  if (!Array.isArray(statuses) || statuses.length < 2) errors.push('at least two statuses are required');
  else {
    const seen = new Set();
    for (const s of statuses) {
      const k = String(s).trim().toLowerCase();
      if (!k) errors.push('empty status name');
      if (k === 'draft') errors.push('"Draft" is reserved by Backlog.md for drafts and cannot be a column');
      if (String(s).includes(',')) errors.push(`status "${s}" must not contain a comma`);
      if (seen.has(k)) errors.push(`duplicate status "${s}"`);
      seen.add(k);
    }
  }
  return errors;
}

// Mirrors the rules `backlog init --task-prefix` enforces, so a bad prefix fails
// in the dry run rather than halfway through creating the board.
const RESERVED_PREFIXES = ['draft', 'doc', 'decision'];

export function validateTaskPrefix(prefix) {
  if (!/^[A-Za-z]+$/.test(String(prefix))) return `invalid_task_prefix: "${prefix}" must contain only letters (a-z).`;
  if (RESERVED_PREFIXES.includes(String(prefix).toLowerCase())) return `invalid_task_prefix: "${prefix}" is reserved by Backlog.md. Choose another prefix.`;
  return null;
}

// Initials for multi-word names (claude-marketplace → CM), otherwise the first letters.
export function suggestTaskPrefix(name) {
  const words = String(name).split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  const joined = words.join('');
  const candidates = [words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : '', joined.slice(0, 3), joined.slice(0, 4)];
  const usable = candidates.find((c) => c.length >= 2 && c.toLowerCase() !== 'task' && !validateTaskPrefix(c));
  return (usable ?? 'PROJ').toUpperCase();
}

export function resolveColumns(columns) {
  if (typeof columns === 'string') {
    const preset = COLUMN_PRESETS()[columns];
    if (!preset) throw new Error(`Unknown column preset "${columns}"`);
    return { id: columns, ...preset, default_status: preset.statuses[0] };
  }
  const statuses = columns?.statuses;
  const errors = validateStatuses(statuses);
  if (errors.length) throw new Error(errors.join('; '));
  return { id: 'custom', statuses, classes: columns.classes ?? inferClasses(statuses, statuses[0]), default_status: statuses[0], transitions: columns.transitions, labels: columns.labels };
}

export function resolveFields(fields) {
  if (typeof fields === 'string') {
    const preset = FIELD_PRESETS()[fields];
    if (!preset) throw new Error(`Unknown field preset "${fields}"`);
    return { id: fields, ...preset };
  }
  return { id: 'custom', enforcement: 'warn', strictMilestones: true, gates: {}, dod: [], labels: [], ...fields };
}

export function buildPolicy(fields, classes, columnsId, transitions, enforcementOverride) {
  return {
    version: 1,
    preset: { columns: columnsId, fields: fields.id },
    enforcement: enforcementOverride ?? fields.enforcement,
    strictMilestones: fields.strictMilestones,
    statusClasses: classes,
    gates: fields.gates,
    transitions: transitions ?? [],
  };
}

function initFlags(mode, spec) {
  const flags = ['--defaults', '--integration-mode', 'none', '--auto-open-browser', 'false'];
  if (mode === 'local') flags.push('--no-git');
  else flags.push('--include-remote', 'false', '--check-branches', mode === 'in-tree' ? 'true' : 'false');
  if (spec.taskPrefix) flags.push('--task-prefix', spec.taskPrefix);
  return flags;
}

function refState(ctx, branch) {
  const local = git(ctx.cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code === 0;
  const hasOrigin = git(ctx.cwd, ['remote', 'get-url', 'origin']).code === 0;
  let remote = false;
  let offline = false;
  if (hasOrigin) {
    const r = git(ctx.cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeout: 8000 });
    if (r.code !== 0) offline = true;
    else remote = r.stdout.trim().length > 0;
  }
  return { local, hasOrigin, remote, offline };
}

function hasBoard(ctx, ref) {
  return ['backlog/config.yml', '.backlog/config.yml', 'backlog.config.yml'].some((f) => git(ctx.cwd, ['cat-file', '-e', `${ref}:${f}`]).code === 0);
}

function defaultFolder(ctx) {
  const slug = path.basename(ctx.projectDir ?? ctx.cwd).replace(/[^\w.-]+/g, '-');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'backlog-md', 'boards', slug);
}

export function normalizeExisting(input) {
  const abs = realpath(input.replace(/^~(?=$|\/)/, os.homedir()));
  if (exists(path.join(abs, 'config.yml')) && !findBacklogDir(abs)) {
    return { root: path.dirname(abs), dirName: path.basename(abs) };
  }
  const dirName = findBacklogDir(abs);
  return dirName ? { root: abs, dirName } : null;
}

function worktreePath(ctx) {
  return path.join(ctx.commonDir, REF_WORKTREE);
}

function worktreeRegistered(ctx, wt) {
  return git(ctx.cwd, ['worktree', 'list', '--porcelain']).stdout.split('\n').some((l) => l === `worktree ${wt}`);
}

// Restores a missing or broken dedicated-ref worktree.
export function heal(ctx) {
  if (ctx.state?.mode !== 'ref') return { ok: exists(boardRoot(ctx) ?? '') };
  const wt = worktreePath(ctx);
  const branch = ctx.state.branch ?? 'backlog';
  if (exists(wt)) {
    if (git(wt, ['rev-parse', '--git-dir']).code === 0) return { ok: true };
    git(ctx.cwd, ['worktree', 'repair', wt]);
    return { ok: git(wt, ['rev-parse', '--git-dir']).code === 0, error: 'worktree link is broken' };
  }
  if (worktreeRegistered(ctx, wt)) {
    git(ctx.cwd, ['worktree', 'unlock', wt]);
    git(ctx.cwd, ['worktree', 'prune']);
  }
  const local = git(ctx.cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code === 0;
  const add = local ? git(ctx.cwd, ['worktree', 'add', '--quiet', wt, branch]) : git(ctx.cwd, ['worktree', 'add', '--quiet', wt, '-b', branch, '--track', `origin/${branch}`]);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() };
  git(ctx.cwd, ['worktree', 'lock', '--reason', 'backlog-md board', wt]);
  return { ok: true, repaired: true };
}

function plan(ctx, spec) {
  const errors = [];
  const actions = [];
  const notes = [];
  const out = { mode: spec.mode, attach: false, errors, actions, notes };
  if (!ctx.git && ['ref', 'in-tree', 'local'].includes(spec.mode)) errors.push(`Storage mode "${spec.mode}" requires a git repository.`);
  if (errors.length) return out;

  if (spec.mode === 'ref') {
    const branch = spec.branch || 'backlog';
    out.branch = branch;
    if (git(ctx.cwd, ['check-ref-format', '--branch', branch]).code !== 0) errors.push(`"${branch}" is not a valid branch name.`);
    if (git(ctx.cwd, ['for-each-ref', `refs/heads/${branch}/`]).stdout.trim()) errors.push(`branch_collision: branches named "${branch}/..." exist, so "${branch}" cannot be created. Choose another name.`);
    const s = refState(ctx, branch);
    Object.assign(out, { ref: s });
    if (s.offline) notes.push('Could not reach origin; continuing with local information only. If a teammate already created this board, attach after going online to avoid two separate histories.');
    if (s.remote && !s.local) git(ctx.cwd, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 15000 });
    const boardRef = s.local ? `refs/heads/${branch}` : s.remote ? `refs/remotes/origin/${branch}` : null;
    if (boardRef) {
      if (hasBoard(ctx, boardRef)) {
        out.attach = true;
        actions.push(`Attach the existing board on branch "${branch}" at ${worktreePath(ctx)}`);
      } else errors.push(`branch_collision: branch "${branch}" already exists and is not a board. Choose another name.`);
    } else {
      actions.push(`Create branch "${branch}" (no shared history with your code), checked out at ${worktreePath(ctx)}`);
    }
    notes.push('Board commits are made by the plugin with repository git hooks and commit signing turned off for those commits.');
  }
  if (spec.mode === 'folder') {
    out.path = realpath(spec.path ? spec.path.replace(/^~(?=$|\/)/, os.homedir()) : defaultFolder(ctx));
    if (exists(out.path) && findBacklogDir(out.path)) errors.push(`${out.path} already holds a board. Use storage mode "existing".`);
    actions.push(`Create a board at ${out.path} in its own git repository`);
  }
  if (spec.mode === 'existing') {
    const found = spec.path ? normalizeExisting(spec.path) : null;
    if (!found) errors.push(`No Backlog.md board found at ${spec.path}.`);
    else {
      Object.assign(out, found, { attach: true });
      actions.push(`Use the existing board at ${found.root}; statuses are left as they are`);
    }
  }
  if (spec.mode === 'in-tree') {
    if (findBacklogDir(ctx.topLevel)) {
      out.attach = true;
      actions.push(`Adopt the board already in ${ctx.topLevel}`);
    } else actions.push(`Create backlog/ in ${ctx.topLevel}, tracked with your code`);
  }
  if (spec.mode === 'local') actions.push(`Create a private board in ${path.join(ctx.commonDir, LOCAL_DIR)} (not versioned, not shared)`);
  if (!['ref', 'folder', 'existing', 'in-tree', 'local'].includes(spec.mode)) errors.push(`Unknown storage mode "${spec.mode}".`);
  return out;
}

export function dryRun(spec, cwd = process.cwd()) {
  const ctx = resolveContext(cwd);
  const p = plan(ctx, spec);
  if (!p.errors.length && !p.attach) {
    const columns = resolveColumns(spec.columns ?? 'standard');
    const fields = resolveFields(spec.fields ?? 'agent-ready');
    const prefixError = spec.taskPrefix == null ? null : validateTaskPrefix(spec.taskPrefix);
    if (prefixError) p.errors.push(prefixError);
    p.actions.push(`Task IDs: ${String(spec.taskPrefix ?? 'task').toUpperCase()}-1, ${String(spec.taskPrefix ?? 'task').toUpperCase()}-2, ...`);
    p.actions.push(`Columns: ${columns.statuses.join(' → ')}`);
    p.actions.push(`Required fields preset: ${fields.label ?? fields.id}`);
    if (fields.dod?.length) p.actions.push(`Definition of Done defaults: ${fields.dod.join('; ')}`);
    for (const m of spec.milestones ?? []) p.actions.push(`Create milestone: ${m}`);
    if (fields.requiresMilestone && !(spec.milestones ?? []).length) p.errors.push('milestone_required: this field preset requires tasks to have a milestone; provide at least one first milestone.');
  } else if (!p.errors.length && spec.mode === 'existing') {
    const paths = { dir: path.join(p.root, p.dirName) };
    const cfg = readConfig(findConfigFile(p.root, p.dirName));
    p.detected = { statuses: cfg.statuses ?? [], classes: inferClasses(cfg.statuses ?? [], cfg.default_status), hasPolicy: exists(path.join(paths.dir, 'plugin-policy.json')) };
  }
  return p;
}

function findConfigFile(root, dirName) {
  const rootConfig = path.join(root, 'backlog.config.yml');
  return exists(rootConfig) ? rootConfig : path.join(root, dirName, 'config.yml');
}

function createRefBranch(ctx, branch, undo) {
  const tree = git(ctx.cwd, ['mktree'], { input: '' }).stdout.trim();
  const commit = git(ctx.cwd, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'chore(backlog): initialize board [skip ci]'], { env: commitIdentityEnv(ctx.cwd) });
  if (commit.code !== 0) throw new Error(`could not create root commit: ${commit.stderr.trim()}`);
  const update = git(ctx.cwd, ['update-ref', `refs/heads/${branch}`, commit.stdout.trim(), '']);
  if (update.code !== 0) throw new Error(`could not create branch: ${update.stderr.trim()}`);
  undo.push(() => git(ctx.cwd, ['update-ref', '-d', `refs/heads/${branch}`]));
}

function addWorktree(ctx, branch, fromRemote, undo) {
  const wt = worktreePath(ctx);
  if (exists(wt) && worktreeRegistered(ctx, wt)) return wt;
  git(ctx.cwd, ['worktree', 'prune']);
  const args = fromRemote ? ['worktree', 'add', '--quiet', wt, '-b', branch, '--track', `origin/${branch}`] : ['worktree', 'add', '--quiet', wt, branch];
  const r = git(ctx.cwd, args);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  undo.push(() => {
    git(ctx.cwd, ['worktree', 'unlock', wt]);
    git(ctx.cwd, ['worktree', 'remove', '--force', wt]);
  });
  git(ctx.cwd, ['worktree', 'lock', '--reason', 'backlog-md board', wt]);
  return wt;
}

function initBoard(real, root, name, mode, spec) {
  const env = { ...process.env, BACKLOG_CWD: root };
  const r = run(real, ['init', name, ...initFlags(mode, spec)], { env, cwd: root, timeout: 60000 });
  if (r.code !== 0) throw new Error(`backlog init failed: ${(r.stderr || r.stdout).trim()}`);
  return env;
}

function applyBoardDefaults(real, env, configFile, dir, columns, fields, spec) {
  const labels = [...new Set([...(fields.labels ?? []), ...(columns.labels ?? []), ...(spec.labels ?? [])])];
  setConfigKeys(configFile, { statuses: columns.statuses, default_status: columns.default_status, labels, definition_of_done: spec.dod ?? fields.dod ?? [] });
  const check = readConfig(configFile);
  if (!check.statuses?.includes(check.default_status)) throw new Error('default_status is not one of the configured statuses');
  for (const m of spec.milestones ?? []) {
    const r = run(real, ['milestone', 'add', m], { env, timeout: 15000 });
    if (r.code !== 0) throw new Error(`could not create milestone "${m}": ${(r.stderr || r.stdout).trim()}`);
  }
}

export function applySetup(spec, cwd = process.cwd()) {
  const ctx = resolveContext(cwd);
  const p = dryRun(spec, cwd);
  if (p.errors.length) return { ok: false, errors: p.errors, notes: p.notes };
  const real = findRealCli();
  if (!real) return { ok: false, errors: [INSTALL_HELP] };
  if (!versionOk(cliVersion(real))) return { ok: false, errors: [`Backlog.md ${cliVersion(real)} is older than the minimum supported version. Upgrade with: npm i -g backlog.md`] };

  const undo = [];
  const projectName = spec.projectName || path.basename(ctx.projectDir ?? ctx.cwd);
  const state = { version: 1, mode: spec.mode, sync: 'manual', autoApprove: spec.autoApprove ?? 'writes' };
  try {
    let root;
    let dirName = 'backlog';
    if (spec.mode === 'ref') {
      state.branch = p.branch;
      if (!p.attach) createRefBranch(ctx, p.branch, undo);
      root = addWorktree(ctx, p.branch, p.attach && !p.ref.local, undo);
      dirName = findBacklogDir(root) ?? 'backlog';
      if (p.ref.hasOrigin && spec.sync === 'auto') state.sync = 'auto';
    } else if (spec.mode === 'folder') {
      fs.mkdirSync(p.path, { recursive: true });
      root = p.path;
      state.boardRoot = root;
      if (git(root, ['rev-parse', '--git-dir']).code !== 0) {
        git(root, ['init', '--quiet', '-b', 'main']);
        undo.push(() => fs.rmSync(path.join(root, '.git'), { recursive: true, force: true }));
      }
    } else if (spec.mode === 'existing') {
      root = p.root;
      dirName = p.dirName;
      state.boardRoot = root;
    } else if (spec.mode === 'in-tree') {
      root = ctx.topLevel;
      dirName = findBacklogDir(root) ?? 'backlog';
    } else if (spec.mode === 'local') {
      root = path.join(ctx.commonDir, LOCAL_DIR);
      fs.mkdirSync(root, { recursive: true });
      undo.push(() => fs.rmSync(root, { recursive: true, force: true }));
    }
    state.backlogDir = dirName;

    if (!p.attach) {
      const columns = resolveColumns(spec.columns ?? 'standard');
      const fields = resolveFields(spec.fields ?? 'agent-ready');
      const env = initBoard(real, root, projectName, spec.mode, spec);
      if (spec.mode === 'in-tree') undo.push(() => fs.rmSync(path.join(root, dirName), { recursive: true, force: true }));
      const dir = path.join(root, dirName);
      applyBoardDefaults(real, env, findConfigFile(root, dirName), dir, columns, fields, spec);
      writeJson(path.join(dir, 'plugin-policy.json'), buildPolicy(fields, columns.classes, columns.id, columns.transitions, spec.enforcement));
      if (spec.mode === 'ref' || spec.mode === 'folder') writeAtomic(path.join(root, '.gitignore'), `${dirName}/.locks/\n`);
    } else {
      const policyFile = path.join(root, dirName, 'plugin-policy.json');
      if (!exists(policyFile) || spec.forcePolicy) {
        const config = readConfig(findConfigFile(root, dirName));
        const fields = resolveFields(spec.fields ?? 'agent-ready');
        const classes = spec.classes ?? inferClasses(config.statuses ?? [], config.default_status);
        writeJson(policyFile, buildPolicy(fields, classes, 'existing', spec.transitions, spec.enforcement));
        const labels = [...new Set([...(config.labels ?? []), ...(fields.labels ?? []), ...(spec.labels ?? [])])];
        if (spec.applyDefaults !== false) setConfigKeys(findConfigFile(root, dirName), { labels });
      }
    }

    // State is written last: it is what marks the project as configured.
    saveState(ctx, state);
    if (spec.mode === 'ref' && p.branch !== 'backlog' && ctx.topLevel) {
      writeJson(path.join(ctx.topLevel, '.claude', 'backlog-md.json'), { branch: p.branch });
    }
    const commit = commitBoard(ctx);
    return { ok: true, mode: spec.mode, attach: p.attach, boardRoot: boardRoot(resolveContext(cwd)), sync: state.sync, notes: p.notes, commit };
  } catch (e) {
    for (const fn of undo.reverse()) {
      try {
        fn();
      } catch {
        /* keep undoing the remaining steps */
      }
    }
    return { ok: false, errors: [e.message] };
  }
}

function untrustedCallbacks(ctx) {
  const trusted = new Set(ctx.state.trustedCallbacks ?? []);
  return allCallbacks(ctx).filter((c) => !trusted.has(hashCallback(c.value)));
}

// Later changes through /backlog-md:setup when the project is already configured.
export function reconfigure(spec, cwd = process.cwd()) {
  const ctx = resolveContext(cwd);
  if (!ctx.state?.mode) return { ok: false, errors: ['This project is not configured yet.'] };
  const paths = boardPaths(ctx);
  const real = findRealCli();
  const env = { ...process.env, BACKLOG_CWD: paths.root };
  const policy = readJson(paths.policy) ?? {};
  const changed = [];

  if (spec.columns) {
    const columns = resolveColumns(spec.columns);
    const current = readConfig(paths.config).statuses ?? [];
    const lower = new Set(columns.statuses.map((s) => s.toLowerCase()));
    const removed = current.filter((s) => !lower.has(s.toLowerCase()));
    const listed = listTasks(real, env);
    if (listed.error) return { ok: false, errors: [`Could not read the board: ${listed.error}`] };
    const affected = listed.tasks.filter((t) => removed.some((s) => s.toLowerCase() === String(t.status).toLowerCase()));
    const missing = [...new Set(affected.map((t) => t.status))].filter((s) => !spec.statusMap?.[s]);
    if (missing.length) return { ok: false, errors: [`status_mapping_required: tasks use removed status(es): ${missing.join(', ')}. Provide statusMap.`], affected: affected.map((t) => ({ id: t.id, status: t.status })) };
    if (affected.length && untrustedCallbacks(ctx).length) return { ok: false, errors: ['This board has untrusted onStatusChange callbacks; run backlog-md trust-callbacks first.'] };
    setConfigKeys(paths.config, { statuses: columns.statuses, default_status: columns.default_status });
    for (const t of affected) {
      const r = run(real, ['task', 'edit', t.id, '-s', spec.statusMap[t.status]], { env, timeout: 15000 });
      if (r.code !== 0) return { ok: false, errors: [`Failed to move ${t.id}: ${(r.stderr || r.stdout).trim()}`] };
    }
    Object.assign(policy, { statusClasses: columns.classes, transitions: columns.transitions ?? [], preset: { ...policy.preset, columns: columns.id } });
    changed.push('columns');
  }
  if (spec.classes) {
    policy.statusClasses = spec.classes;
    changed.push('classes');
  }
  if (spec.fields) {
    const fields = resolveFields(spec.fields);
    Object.assign(policy, { enforcement: spec.enforcement ?? fields.enforcement, strictMilestones: fields.strictMilestones, gates: fields.gates, preset: { ...policy.preset, fields: fields.id } });
    const cfg = readConfig(paths.config);
    setConfigKeys(paths.config, { labels: [...new Set([...(cfg.labels ?? []), ...(fields.labels ?? [])])] });
    changed.push('fields');
  } else if (spec.enforcement) {
    policy.enforcement = spec.enforcement;
    changed.push('enforcement');
  }
  for (const m of spec.milestones ?? []) run(real, ['milestone', 'add', m], { env, timeout: 15000 });
  writeJson(paths.policy, policy);
  const statePatch = {};
  if (spec.sync) statePatch.sync = spec.sync;
  if (spec.autoApprove) statePatch.autoApprove = spec.autoApprove;
  if (Object.keys(statePatch).length) {
    saveState(ctx, statePatch);
    changed.push('settings');
  }
  commitBoard(ctx);
  return { ok: true, changed };
}
