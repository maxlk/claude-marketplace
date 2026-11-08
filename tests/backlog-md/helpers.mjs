import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN = path.join(REPO, 'plugins', 'backlog-md');
export const BIN = path.join(PLUGIN, 'bin');
const REAL_BIN_DIR = process.env.BACKLOG_BIN_DIR;

export function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'blmd test ')));
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PATH: `${BIN}:${REAL_BIN_DIR ? `${REAL_BIN_DIR}:` : ''}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'),
    CLAUDE_CODE_SESSION_ID: 'sess-1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  delete env.BACKLOG_CWD;
  delete env.CI;
  return { root, env };
}

export function exec(cmd, args, { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function gitRepo(sb, name = 'app') {
  const dir = path.join(sb.root, name);
  fs.mkdirSync(dir, { recursive: true });
  exec('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, env: sb.env });
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  exec('git', ['add', '.'], { cwd: dir, env: sb.env });
  exec('git', ['commit', '-qm', 'init'], { cwd: dir, env: sb.env });
  return dir;
}

export function backlog(sb, cwd, ...args) {
  return exec(path.join(BIN, 'backlog'), args, { cwd, env: sb.env });
}

export function admin(sb, cwd, args, spec) {
  return exec(path.join(BIN, 'backlog-md'), args, { cwd, env: sb.env, input: spec === undefined ? '' : JSON.stringify(spec) });
}

export function setup(sb, cwd, spec) {
  const r = admin(sb, cwd, ['setup'], spec);
  return { ...r, json: JSON.parse(r.out || '{}') };
}

export function hook(sb, event, payload, extraEnv = {}) {
  const env = { ...sb.env, CLAUDE_PLUGIN_ROOT: PLUGIN, ...extraEnv };
  const r = exec('sh', [path.join(PLUGIN, 'hooks', 'gate.sh'), event], { cwd: payload.cwd, env: { ...env, CLAUDE_PROJECT_DIR: payload.cwd }, input: JSON.stringify(payload) });
  return { ...r, json: r.out ? JSON.parse(r.out) : null };
}

export function git(sb, cwd, ...args) {
  return exec('git', args, { cwd, env: sb.env });
}

export const wt = (repo) => path.join(repo, '.git', 'backlog-wt');
export const view = (sb, cwd, id) => JSON.parse(backlog(sb, cwd, 'task', 'view', id, '--json').out).task;
