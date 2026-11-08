// Entry point behind bin/backlog. Routes Claude's `backlog` calls to the
// configured board and applies the project's gates before anything is written.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './common.mjs';
import { boardPaths, boardRoot, findRealCli, INSTALL_HELP, isConfigured, loadPolicy, patchRuntime, resolveContext, saveState } from './context.mjs';
import { callbacksFor, findBoardFile, hashCallback, listIds, loadMilestones, milestoneExists, normalizeDraftId, readConfig, taskFromFile, viewTask } from './board.mjs';
import { classify, createModel, editModel, parseCreate, parseEdit } from './argv.mjs';
import { classOf, evaluate, needsApproval, rankOf, stagesFor } from './policy.mjs';
import { touch } from './ledger.mjs';
import { heal } from './setup.mjs';
import { pullBeforeCreate } from './sync.mjs';

const LOCK_MESSAGE = 'being modified by another process';
const say = (msg) => process.stderr.write(`${msg}\n`);

function fail(msg) {
  say(`[backlog-md] ${msg}`);
  process.exit(1);
}

function inherit(real, args, env) {
  const r = spawnSync(real, args, { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

function runPiped(real, args, env) {
  let delay = 120;
  for (let attempt = 0; ; attempt += 1) {
    const r = spawnSync(real, args, { env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0 && combined.includes(LOCK_MESSAGE) && attempt < 9) {
      sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 1.6, 900);
      continue;
    }
    return { code: r.status ?? (r.error?.code === 'ETIMEDOUT' ? 124 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
}

function finish(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

function touchedFrom(output) {
  return [...output.matchAll(/(?:Updated task|Created task|^Task) ([A-Za-z]+-\d+(?:\.\d+)?)/gm)].map((m) => m[1].toUpperCase()).filter((id) => !id.startsWith('DRAFT-'));
}

function canonicalStatus(config, status) {
  const found = (config.statuses ?? []).find((s) => s.toLowerCase() === String(status).toLowerCase());
  return found ?? status;
}

function report(violations, heading, tail = []) {
  const blocking = violations.filter((v) => v.level === 'block');
  const lines = [`[backlog-md] ${heading}`, ...violations.map((v) => `  ${v.level === 'block' ? 'BLOCK' : 'warn '} [${v.stage}] ${v.message}`), ...tail];
  say(lines.join('\n'));
  return blocking.length > 0;
}

function guardCallbacks(ctx, file) {
  let found;
  try {
    found = callbacksFor(ctx, file);
  } catch (e) {
    fail(`Status change refused: could not inspect this board for onStatusChange callbacks (${e.message}).`);
  }
  const trusted = new Set(ctx.state.trustedCallbacks ?? []);
  const untrusted = found.filter((c) => !trusted.has(hashCallback(c.value)));
  if (untrusted.length) {
    fail(
      `Status change refused: this board defines an onStatusChange shell callback, which would execute on this machine.\n${untrusted
        .map((c) => `  ${c.where}: ${c.value}`)
        .join('\n')}\nShow this to the user. Only if they accept it, run: backlog-md trust-callbacks`,
    );
  }
}

function gateCreate(ctx, policy, env, real, tokens) {
  const { options: o, unknown } = parseCreate(tokens);
  if (o.help || o.draft) return;
  const config = readConfig(boardPaths(ctx).config);
  if (String(o.status ?? '').toLowerCase() === 'draft') return;
  if (unknown.length) {
    say(`[backlog-md] warning: unrecognized flag(s) ${unknown.join(', ')}: gates ran on the flags understood; check the plugin version.`);
  }
  const milestones = loadMilestones(boardPaths(ctx).dir);
  if (policy.strictMilestones !== false && o.milestone && !milestoneExists(milestones, o.milestone)) {
    fail(`Unknown milestone "${o.milestone}" (Backlog.md would accept it silently). Create it first with: backlog milestone add "${o.milestone}"\nExisting: ${milestones.map((m) => m.title).join(', ') || '(none)'}`);
  }
  const task = createModel(o, config);
  const cls = classOf(policy, canonicalStatus(config, task.status));
  const violations = evaluate(policy, task, stagesFor(cls), { config, milestones });
  if (violations.length && report(violations, 'Task does not meet this project\'s required fields:')) {
    fail('Task NOT created. Add the fields above, then retry the same command.');
  }
  if (needsApproval(policy, task.status, cls)) fail(`Creating a task directly in "${task.status}" requires human approval on this project.`);
}

function gateEdit(ctx, policy, env, real, tokens) {
  const { options: o, positional: ids, unknown } = parseEdit(tokens);
  if (o.help || ids.length === 0) return [];
  const config = readConfig(boardPaths(ctx).config);
  const statusChange = o.status !== undefined && String(o.status).toLowerCase() !== 'draft';
  if (unknown.length) {
    if (statusChange) fail(`Status change refused: unrecognized flag(s) ${unknown.join(', ')} mean the required-field gates cannot be evaluated. Remove them, or update the plugin.`);
    say(`[backlog-md] warning: unrecognized flag(s) ${unknown.join(', ')}.`);
  }
  const milestones = loadMilestones(boardPaths(ctx).dir);
  if (policy.strictMilestones !== false && o.milestone && !milestoneExists(milestones, o.milestone)) {
    fail(`Unknown milestone "${o.milestone}". Create it first with: backlog milestone add "${o.milestone}"\nExisting: ${milestones.map((m) => m.title).join(', ') || '(none)'}`);
  }
  const envData = { config, milestones };
  const approvals = { ...(ctx.state.approvals ?? {}) };
  const consumed = [];
  let blocked = false;
  // Validate every ID first: the CLI applies multi-ID edits partially on error.
  const loaded = ids.map((id) => {
    const r = viewTask(real, env, id);
    if (r.error) fail(`Cannot edit ${id}: ${r.error}\nNothing was changed.`);
    return { id, task: r.task };
  });
  let activeId = null;
  for (const { id, task } of loaded) {
    if (statusChange) guardCallbacks(ctx, path.join(boardPaths(ctx).root, task.path));
    const merged = editModel(task, statusChange ? { ...o, status: canonicalStatus(config, o.status) } : o);
    const fromCls = classOf(policy, task.status);
    const toCls = classOf(policy, merged.status);
    let violations;
    if (statusChange && rankOf(toCls) > rankOf(fromCls)) {
      violations = evaluate(policy, merged, stagesFor(toCls), envData);
      if (toCls === 'active') activeId = task.id;
      if (needsApproval(policy, merged.status, toCls)) {
        if (approvals[task.id]) consumed.push(task.id);
        else {
          say(`[backlog-md] ${task.id}: moving to "${merged.status}" requires human approval. Ask the user, then have them approve: backlog-md approve ${task.id}`);
          blocked = true;
        }
      }
    } else {
      // No forward move: only flag what this edit newly breaks.
      const stages = stagesFor(fromCls);
      const before = new Set(evaluate(policy, task, stages, envData).map((v) => v.key));
      violations = evaluate(policy, merged, stages, envData).filter((v) => !before.has(v.key));
    }
    if (violations.length && report(violations, `${task.id} would not meet this project's required fields:`)) blocked = true;
  }
  if (blocked) fail('Edit NOT applied to any task. Fix the items above, then retry.');
  return { consumed, activeId };
}

function gatePromote(ctx, policy, env, real, tokens) {
  const id = tokens.find((t) => !t.startsWith('-'));
  if (!id) return null;
  const file = findBoardFile(ctx, 'drafts', normalizeDraftId(id));
  if (!file) return listIds(ctx, 'tasks');
  const config = readConfig(boardPaths(ctx).config);
  const task = taskFromFile(fs.readFileSync(file, 'utf8'));
  const violations = evaluate(policy, task, stagesFor(classOf(policy, config.default_status)), { config, milestones: loadMilestones(boardPaths(ctx).dir) });
  if (violations.length && report(violations, `${task.id} cannot be promoted yet:`)) {
    fail(`Draft NOT promoted. Complete it with: backlog draft edit ${id} ...`);
  }
  return listIds(ctx, 'tasks');
}

function main() {
  const argv = process.argv.slice(2);
  const real = findRealCli();
  if (!real) {
    say(INSTALL_HELP);
    process.exit(127);
  }
  let ctx;
  try {
    ctx = resolveContext();
  } catch {
    inherit(real, argv, process.env);
  }
  if (!isConfigured(ctx)) inherit(real, argv, process.env);

  const root = boardRoot(ctx);
  if (!root || !fs.existsSync(root)) {
    const healed = heal(ctx);
    if (!healed.ok) fail(`Board unavailable at ${root}: ${healed.error ?? 'missing'}. Run /backlog-md:doctor.`);
  }
  const env = { ...process.env, BACKLOG_CWD: root };
  const cmd = classify(argv);
  if (cmd.kind === 'init') fail('This project already has a board configured. Use /backlog-md:setup to change it.');

  const longRunning = argv[0] === 'browser' || argv[0] === 'mcp' || argv.includes('--watch');
  // Interactive TUIs need the terminal; writes always take the gated path below.
  if (longRunning || (cmd.kind === 'other' && process.stdout.isTTY && process.stdin.isTTY)) inherit(real, argv, env);

  const policy = loadPolicy(ctx) ?? { enforcement: 'off', gates: {}, statusClasses: {}, strictMilestones: false };
  let edit = null;
  let beforePromote = null;
  if (cmd.kind === 'task-create') {
    gateCreate(ctx, policy, env, real, cmd.tokens);
    pullBeforeCreate(ctx);
  } else if (cmd.kind === 'task-edit') edit = gateEdit(ctx, policy, env, real, cmd.tokens);
  else if (cmd.kind === 'draft-promote') {
    guardCallbacks(ctx, null);
    beforePromote = gatePromote(ctx, policy, env, real, cmd.tokens);
  }

  const result = runPiped(real, argv, env);
  finish(result);

  if (cmd.kind === 'other') return;
  const touched = touchedFrom(`${result.stdout}\n${result.stderr}`);
  if (cmd.kind === 'task-edit' && result.code === 0) {
    const { positional } = parseEdit(cmd.tokens);
    touched.push(...positional.map((p) => (/^\d/.test(p) ? `${(readConfig(boardPaths(ctx).config).task_prefix ?? 'task').toUpperCase()}-${p}` : p.toUpperCase())));
  }
  if (cmd.kind === 'draft-promote' && result.code === 0 && beforePromote) {
    for (const f of listIds(ctx, 'tasks')) if (!beforePromote.has(f)) touched.push(f.split(' - ')[0].toUpperCase());
  }
  if (touched.length) touch(ctx, [...new Set(touched)], edit?.activeId);
  if (edit?.consumed?.length && result.code === 0) {
    const approvals = { ...(ctx.state.approvals ?? {}) };
    for (const id of edit.consumed) delete approvals[id];
    saveState(ctx, { approvals });
  }
  patchRuntime(ctx, { lastWrite: Date.now() });
}

main();
