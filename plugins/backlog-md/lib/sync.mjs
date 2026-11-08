// Commits and synchronizes boards the plugin owns (dedicated ref and folder).
// In-tree, local and existing boards are never committed by the plugin.
import fs from 'node:fs';
import path from 'node:path';
import { exists, git, run, withLock } from './common.mjs';
import { boardRoot, findRealCli, patchRuntime, readRuntime } from './context.mjs';
import { ledgerPath } from './ledger.mjs';

export const COMMIT_DEBOUNCE_MS = 10 * 60 * 1000;
export const PUSH_DEBOUNCE_MS = 5 * 60 * 1000;
const CREATE_PULL_DEBOUNCE_MS = 60 * 1000;

export const isOwned = (ctx) => ['ref', 'folder'].includes(ctx.state?.mode);

function lockDir(ctx) {
  return path.join(ctx.stateDir, 'commit.lock');
}

function identityEnv(root) {
  const name = git(root, ['config', 'user.name']).stdout.trim();
  const email = git(root, ['config', 'user.email']).stdout.trim();
  const env = {};
  if (!name) Object.assign(env, { GIT_AUTHOR_NAME: 'backlog-md', GIT_COMMITTER_NAME: 'backlog-md' });
  if (!email) Object.assign(env, { GIT_AUTHOR_EMAIL: 'backlog-md@localhost', GIT_COMMITTER_EMAIL: 'backlog-md@localhost' });
  return env;
}

export function commitIdentityEnv(root) {
  return identityEnv(root);
}

function idsFromPaths(names) {
  const ids = new Set();
  for (const n of names) {
    const m = path.basename(n).match(/^([a-z]+-\d+(?:\.\d+)?) - /i);
    if (m) ids.add(m[1].toUpperCase());
  }
  return [...ids];
}

export function commitBoard(ctx) {
  if (!isOwned(ctx)) return { skipped: true };
  const root = boardRoot(ctx);
  if (!root || !exists(root)) return { skipped: true };
  const outcome = withLock(lockDir(ctx), 60000, () => {
    if (git(root, ['add', '-A', '.']).code !== 0) return { error: 'git add failed' };
    const names = git(root, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
    if (names.length === 0) return { committed: false };
    const ids = idsFromPaths(names);
    const subject = ids.length ? `update ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` +${ids.length - 5}` : ''}` : 'update board';
    const r = git(root, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', `chore(backlog): ${subject} [skip ci]`], { env: identityEnv(root) });
    if (r.code !== 0) return { error: r.stderr.trim() };
    patchRuntime(ctx, { lastCommit: Date.now() });
    return { committed: true, ids };
  });
  return outcome.locked ? { locked: true } : outcome.value;
}

function target(ctx) {
  const root = boardRoot(ctx);
  const branch = ctx.state.branch ?? git(root, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const hasRemote = git(root, ['remote', 'get-url', 'origin']).code === 0;
  return { root, branch, hasRemote, remoteRef: `refs/remotes/origin/${branch}` };
}

const syncEnabled = (ctx) => isOwned(ctx) && ctx.state?.sync === 'auto';

function setBlocked(ctx, reason) {
  patchRuntime(ctx, { blocked: { reason, at: Date.now() } });
  return { blocked: reason };
}

function checkDuplicates(ctx, root) {
  const real = findRealCli();
  if (!real) return;
  const r = run(real, ['doctor'], { env: { ...process.env, BACKLOG_CWD: root }, timeout: 15000 });
  patchRuntime(ctx, { duplicates: !/No duplicate/i.test(r.stdout) });
}

export function pull(ctx, { timeout = 10000, force = false } = {}) {
  if (!isOwned(ctx) || (!force && !syncEnabled(ctx))) return { skipped: true };
  const { root, branch, hasRemote, remoteRef } = target(ctx);
  if (!hasRemote || !exists(root)) return { skipped: true };
  if (readRuntime(ctx).blocked && !force) return { blocked: readRuntime(ctx).blocked.reason };
  commitBoard(ctx);
  const f = git(root, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:${remoteRef}`], { timeout });
  if (f.code !== 0) return { offline: true, error: f.stderr.trim() };
  patchRuntime(ctx, { lastPull: Date.now() });
  const outcome = withLock(lockDir(ctx), 60000, () => {
    const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(root, ['rev-parse', remoteRef]).stdout.trim();
    if (head === remote) return { upToDate: true };
    if (git(root, ['merge-base', '--is-ancestor', remote, head]).code === 0) return { ahead: true };
    if (git(root, ['merge-base', '--is-ancestor', head, remote]).code === 0) {
      const ff = git(root, ['merge', '--ff-only', '--quiet', remote]);
      if (ff.code !== 0) return { retry: true, error: ff.stderr.trim() };
      checkDuplicates(ctx, root);
      return { fastForwarded: true };
    }
    // Diverged. Merge in the object store first so a conflict never reaches
    // the live working tree.
    const merged = git(root, ['merge-tree', '--write-tree', head, remote]);
    if (merged.code === 1) return setBlocked(ctx, 'conflict');
    if (merged.code !== 0) return setBlocked(ctx, /unrelated histories/.test(merged.stderr) ? 'unrelated-histories' : `merge-failed: ${merged.stderr.trim().slice(0, 200)}`);
    const tree = merged.stdout.trim().split('\n')[0];
    const commit = git(root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', head, '-p', remote, '-m', `chore(backlog): merge ${branch} [skip ci]`], { env: identityEnv(root) });
    if (commit.code !== 0) return setBlocked(ctx, `merge-commit-failed: ${commit.stderr.trim().slice(0, 200)}`);
    const ff = git(root, ['merge', '--ff-only', '--quiet', commit.stdout.trim()]);
    if (ff.code !== 0) return { retry: true, error: ff.stderr.trim() };
    checkDuplicates(ctx, root);
    return { merged: true };
  });
  return outcome.locked ? { locked: true } : outcome.value;
}

export function push(ctx, { force = false } = {}) {
  if (!isOwned(ctx) || (!force && !syncEnabled(ctx))) return { skipped: true };
  const { root, branch, hasRemote, remoteRef } = target(ctx);
  if (!hasRemote || !exists(root)) return { skipped: true };
  if (readRuntime(ctx).blocked) return { blocked: readRuntime(ctx).blocked.reason };
  const hasRemoteRef = git(root, ['rev-parse', '--verify', '-q', remoteRef]).code === 0;
  const ahead = hasRemoteRef ? Number(git(root, ['rev-list', '--count', `${remoteRef}..HEAD`]).stdout.trim() || 0) : 1;
  if (ahead === 0) return { upToDate: true };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Never forced: a rejected push goes through a merge and tries again.
    const r = git(root, ['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { timeout: 20000 });
    if (r.code === 0) {
      patchRuntime(ctx, { lastPush: Date.now() });
      return { pushed: true };
    }
    if (/non-fast-forward|fetch first|stale info/i.test(r.stderr)) {
      const p = pull(ctx, { timeout: 15000 });
      if (p.blocked) return p;
      continue;
    }
    if (/remote rejected|protected branch|GH006|GH013|ruleset|hook declined/i.test(r.stderr)) {
      return setBlocked(ctx, `push-rejected: ${r.stderr.trim().slice(0, 300)}`);
    }
    patchRuntime(ctx, { lastPushError: r.stderr.trim().slice(0, 300) });
    return { offline: true };
  }
  return { retriesExhausted: true };
}

export function pullBeforeCreate(ctx) {
  try {
    if (!syncEnabled(ctx)) return;
    const rt = readRuntime(ctx);
    if (Date.now() - (rt.lastCreatePull ?? 0) < CREATE_PULL_DEBOUNCE_MS) return;
    patchRuntime(ctx, { lastCreatePull: Date.now() });
    pull(ctx, { timeout: 3000 });
  } catch {
    /* A sync problem must never stop a task being created. */
  }
}

export function onStop(ctx) {
  if (!isOwned(ctx)) return;
  const rt = readRuntime(ctx);
  if (Date.now() - (rt.lastCommit ?? 0) >= COMMIT_DEBOUNCE_MS) commitBoard(ctx);
  if (Date.now() - (readRuntime(ctx).lastPush ?? 0) >= PUSH_DEBOUNCE_MS) push(ctx);
}

export function onEnd(ctx, session) {
  commitBoard(ctx);
  push(ctx);
  if (session) fs.rmSync(ledgerPath(ctx, session), { force: true });
}

export function onStart(ctx) {
  commitBoard(ctx);
  pull(ctx);
}

export function syncStatus(ctx) {
  const rt = readRuntime(ctx);
  const info = { owned: isOwned(ctx), mode: ctx.state?.mode, sync: ctx.state?.sync ?? 'manual', blocked: rt.blocked ?? null, duplicates: Boolean(rt.duplicates), lastCommit: rt.lastCommit ?? null, lastPull: rt.lastPull ?? null, lastPush: rt.lastPush ?? null, lastPushError: rt.lastPushError ?? null };
  if (isOwned(ctx) && exists(boardRoot(ctx))) {
    const { root, branch, hasRemote, remoteRef } = target(ctx);
    Object.assign(info, { root, branch, hasRemote });
    info.dirty = git(root, ['status', '--porcelain']).stdout.trim().length > 0;
    if (git(root, ['rev-parse', '--verify', '-q', remoteRef]).code === 0) {
      const [behind, ahead] = git(root, ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`]).stdout.trim().split(/\s+/).map(Number);
      Object.assign(info, { ahead, behind });
    }
  }
  return info;
}

export function unblock(ctx) {
  const root = boardRoot(ctx);
  if (isOwned(ctx) && git(root, ['status', '--porcelain']).stdout.split('\n').some((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))) {
    return { error: 'Unresolved merge conflicts remain in the board worktree.' };
  }
  patchRuntime(ctx, { blocked: null });
  return { ok: true };
}
