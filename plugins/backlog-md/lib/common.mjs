// Shared process, filesystem and git helpers. No third-party dependencies.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_BACKLOG_VERSION = '1.55.3';
export const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(LIB_DIR, '..');
export const BIN_DIR = path.join(PLUGIN_ROOT, 'bin');

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 30000,
    killSignal: 'SIGKILL',
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    // Stderr is always piped: Backlog.md can hang when stderr is a closed pipe.
    stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

export function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  };
}

// Every plugin git call skips the repository's hooks: they are not ours to
// trigger, they may prompt, and they can blow the hook time budget.
export function git(cwd, args, opts = {}) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    timeout: opts.timeout ?? 15000,
    env: { ...gitEnv(), ...(opts.env ?? {}) },
    input: opts.input,
  });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function splitList(values) {
  return (values ?? [])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function detached(script, args = []) {
  const child = spawn(process.execPath, [path.join(LIB_DIR, script), ...args], {
    detached: true,
    stdio: 'ignore',
    env: gitEnv(),
  });
  child.unref();
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Lock around board commits. mkdir is atomic and portable (macOS has no flock).
export function withLock(dir, staleMs, fn) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch {
    let age = 0;
    try {
      age = Date.now() - fs.statSync(dir).mtimeMs;
    } catch {
      /* lock vanished: treated as busy for this attempt */
    }
    if (age < staleMs) return { locked: true };
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.mkdirSync(dir);
    } catch {
      return { locked: true };
    }
  }
  try {
    return { value: fn() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
