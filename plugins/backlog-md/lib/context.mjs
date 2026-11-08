// Resolves, per call, which board (if any) the current directory belongs to.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN_DIR, compareVersions, exists, git, MIN_BACKLOG_VERSION, readJson, realpath, run, writeJson } from './common.mjs';

export const REF_WORKTREE = 'backlog-wt';
export const LOCAL_DIR = 'backlog-local';

export function stateRoot() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'backlog-md');
}

function encodePath(p) {
  return p.replace(/[/\\:]/g, '%').slice(-200);
}

export function resolveContext(cwd = process.cwd()) {
  const ctx = { cwd: realpath(cwd), git: false, commonDir: null, topLevel: null, stateDir: null, state: null, projectDir: null };
  const common = git(ctx.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 4000 });
  if (common.code === 0 && common.stdout.trim()) {
    ctx.git = true;
    ctx.commonDir = realpath(common.stdout.trim());
    const top = git(ctx.cwd, ['rev-parse', '--show-toplevel'], { timeout: 4000 });
    ctx.topLevel = top.code === 0 && top.stdout.trim() ? realpath(top.stdout.trim()) : null;
    ctx.projectDir = ctx.topLevel;
    ctx.stateDir = path.join(ctx.commonDir, 'backlog-md');
    ctx.state = readJson(path.join(ctx.stateDir, 'state.json'));
    return ctx;
  }
  // Non-git: look for a project state on this directory or an ancestor.
  const start = process.env.CLAUDE_PROJECT_DIR ? realpath(process.env.CLAUDE_PROJECT_DIR) : ctx.cwd;
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(stateRoot(), 'projects', encodePath(dir));
    const state = readJson(path.join(candidate, 'state.json'));
    if (state) {
      Object.assign(ctx, { projectDir: dir, stateDir: candidate, state });
      return ctx;
    }
    if (dir === path.dirname(dir)) break;
  }
  ctx.projectDir = start;
  ctx.stateDir = path.join(stateRoot(), 'projects', encodePath(start));
  ctx.state = readJson(path.join(ctx.stateDir, 'state.json'));
  return ctx;
}

export function isConfigured(ctx) {
  return Boolean(ctx.state?.mode);
}

export function boardRoot(ctx) {
  const s = ctx.state;
  if (!s?.mode) return null;
  if (s.mode === 'ref') return path.join(ctx.commonDir, REF_WORKTREE);
  if (s.mode === 'local') return path.join(ctx.commonDir, LOCAL_DIR);
  if (s.mode === 'in-tree') return ctx.topLevel ?? ctx.projectDir;
  return s.boardRoot;
}

export function findBacklogDir(root) {
  if (!root) return null;
  const rootConfig = path.join(root, 'backlog.config.yml');
  if (exists(rootConfig)) {
    const m = fs.readFileSync(rootConfig, 'utf8').match(/^backlog_directory:\s*["']?([^"'\n]+)/m);
    return m ? m[1].trim() : 'backlog';
  }
  for (const dir of ['backlog', '.backlog']) if (exists(path.join(root, dir, 'config.yml'))) return dir;
  return null;
}

export function boardPaths(ctx) {
  const root = boardRoot(ctx);
  const dirName = ctx.state?.backlogDir ?? findBacklogDir(root) ?? 'backlog';
  const dir = root ? path.join(root, dirName) : null;
  const configFile = root && exists(path.join(root, 'backlog.config.yml')) ? path.join(root, 'backlog.config.yml') : dir && path.join(dir, 'config.yml');
  return { root, dirName, dir, config: configFile, policy: dir && path.join(dir, 'plugin-policy.json') };
}

export function loadPolicy(ctx) {
  const p = boardPaths(ctx).policy;
  return p ? readJson(p) : null;
}

export function saveState(ctx, patch) {
  ctx.state = { ...(ctx.state ?? {}), ...patch };
  writeJson(path.join(ctx.stateDir, 'state.json'), ctx.state);
}

export function runtimeFile(ctx) {
  return path.join(ctx.stateDir, 'runtime.json');
}

export function readRuntime(ctx) {
  return readJson(runtimeFile(ctx), {});
}

export function patchRuntime(ctx, patch) {
  writeJson(runtimeFile(ctx), { ...readRuntime(ctx), ...patch });
}

export function findRealCli() {
  const self = realpath(BIN_DIR);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const resolved = realpath(dir);
    if (resolved === self || exists(path.join(resolved, 'backlog-md'))) continue;
    const candidate = path.join(dir, 'backlog');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next PATH entry */
    }
  }
  return null;
}

export function cliVersion(real) {
  if (!real) return null;
  const cacheFile = path.join(stateRoot(), 'version-cache.json');
  const cache = readJson(cacheFile, {});
  let mtime = 0;
  try {
    mtime = fs.statSync(realpath(real)).mtimeMs;
  } catch {
    /* an unreadable binary simply misses the cache */
  }
  if (cache.path === real && cache.mtime === mtime && cache.version) return cache.version;
  const r = run(real, ['--version'], { timeout: 8000 });
  const version = r.code === 0 ? r.stdout.trim().split(/\s+/).pop() : null;
  if (version) writeJson(cacheFile, { path: real, mtime, version });
  return version;
}

export function versionOk(v) {
  return Boolean(v) && compareVersions(v, MIN_BACKLOG_VERSION) >= 0;
}

export const INSTALL_HELP = `Backlog.md CLI not found. Install one of:
  npm i -g backlog.md
  bun add -g backlog.md
  brew install backlog-md
(Do not use "npx backlog": that is an unrelated package.)`;
