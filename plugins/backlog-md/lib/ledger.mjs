// Per-session record of tasks this Claude session touched. It scopes the Stop
// audit so legacy tasks are never nagged about.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './common.mjs';

export function ledgerPath(ctx, session) {
  return path.join(ctx.stateDir, 'sessions', `${session.replace(/[^\w.-]/g, '_')}.json`);
}

export function readLedger(ctx, session) {
  return readJson(ledgerPath(ctx, session));
}

export function writeLedger(ctx, session, ledger) {
  writeJson(ledgerPath(ctx, session), ledger);
}

export function currentSession() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

export function touch(ctx, ids, activeId) {
  const session = currentSession();
  if (!session || !ctx.stateDir) return;
  const ledger = readLedger(ctx, session) ?? { startedAt: Date.now(), touched: [], stopBlocks: {} };
  for (const id of ids) if (!ledger.touched.includes(id)) ledger.touched.push(id);
  if (activeId) ledger.active = activeId;
  writeLedger(ctx, session, ledger);
}

export function pruneLedgers(ctx, maxAgeMs = 14 * 24 * 3600 * 1000) {
  const dir = path.join(ctx.stateDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    const file = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file);
    } catch {
      /* best effort */
    }
  }
}
