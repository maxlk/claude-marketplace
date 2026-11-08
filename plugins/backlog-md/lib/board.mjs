// Reads and edits Backlog.md config and task files directly where the CLI
// offers no machine-readable access.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exists, run, writeAtomic } from './common.mjs';
import { boardPaths } from './context.mjs';

function unquote(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    if (t[0] === '"') {
      try {
        return JSON.parse(t);
      } catch {
        return t.slice(1, -1);
      }
    }
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function parseFlow(v) {
  const body = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') cur += body[(i += 1)] ?? '';
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

export function parseConfig(text) {
  const config = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw.trim() === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) items.push(unquote(lines[(i += 1)].replace(/^\s+-\s+/, '')));
      config[key] = items.length ? items : '';
    } else if (raw.trim().startsWith('[')) config[key] = parseFlow(raw);
    else config[key] = unquote(raw);
  }
  return config;
}

export function readConfig(file) {
  return parseConfig(fs.readFileSync(file, 'utf8'));
}

// JSON strings are valid YAML flow scalars, so JSON.stringify is the serializer.
export function setConfigKeys(file, patch) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(patch)) {
    const rendered = `${key}: ${JSON.stringify(value)}`;
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at === -1) lines.push(rendered);
    else {
      let end = at + 1;
      while (end < lines.length && /^\s+-\s+/.test(lines[end])) end += 1;
      lines.splice(at, end - at, rendered);
    }
  }
  writeAtomic(file, `${lines.join('\n')}\n`);
}

export function loadMilestones(dir) {
  const folder = path.join(dir, 'milestones');
  if (!exists(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseFrontmatter(fs.readFileSync(path.join(folder, f), 'utf8')))
    .map((fm) => ({ id: fm.id ?? '', title: fm.title ?? '' }))
    .filter((m) => m.id || m.title);
}

export function milestoneExists(milestones, value) {
  const v = String(value).trim().toLowerCase();
  return milestones.some((m) => m.id.toLowerCase() === v || m.title.toLowerCase() === v);
}

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? parseConfig(m[1]) : {};
}

function section(raw, name) {
  const m = raw.match(new RegExp(`<!-- SECTION:${name}:BEGIN -->\\r?\\n?([\\s\\S]*?)<!-- SECTION:${name}:END -->`));
  return m ? m[1].trim() : null;
}

function checklist(raw, name) {
  const m = raw.match(new RegExp(`<!-- ${name}:BEGIN -->([\\s\\S]*?)<!-- ${name}:END -->`));
  if (!m) return [];
  return [...m[1].matchAll(/^- \[( |x)\] (?:#\d+ )?(.*)$/gm)].map(([, c, text]) => ({ text, checked: c === 'x' }));
}

// Builds the same shape as `task view --json` from a raw task or draft file.
export function taskFromFile(raw) {
  const fm = parseFrontmatter(raw);
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    description: section(raw, 'DESCRIPTION'),
    implementationPlan: section(raw, 'PLAN'),
    implementationNotes: section(raw, 'NOTES'),
    finalSummary: section(raw, 'FINAL_SUMMARY'),
    acceptanceCriteria: checklist(raw, 'AC'),
    definitionOfDone: checklist(raw, 'DOD'),
    assignees: list(fm.assignee),
    labels: list(fm.labels),
    milestone: fm.milestone || null,
    priority: fm.priority || null,
    type: fm.type || null,
    project: fm.project || null,
    dueDate: fm.due_date || null,
    parentTaskId: fm.parent_task_id || null,
    references: list(fm.references),
    documentation: list(fm.documentation),
    modifiedFiles: list(fm.modified_files),
    dependencies: list(fm.dependencies),
    onStatusChange: fm.onStatusChange || null,
  };
}

function idMatches(file, id) {
  const prefix = file.split(' - ')[0].toLowerCase();
  return prefix === id.toLowerCase();
}

export function findBoardFile(ctx, folder, id) {
  const dir = path.join(boardPaths(ctx).dir, folder);
  if (!exists(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.endsWith('.md') && idMatches(f, id));
  return hit ? path.join(dir, hit) : null;
}

export function normalizeDraftId(id) {
  return /^\d+(\.\d+)?$/.test(id) ? `draft-${id}` : id;
}

export function listIds(ctx, folder) {
  const dir = path.join(boardPaths(ctx).dir, folder);
  if (!exists(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')));
}

export function viewTask(real, env, id) {
  const r = run(real, ['task', 'view', id, '--json'], { env, timeout: 15000 });
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() };
  try {
    return { task: JSON.parse(r.stdout).task };
  } catch {
    return { error: 'unparseable JSON from task view' };
  }
}

export function listTasks(real, env, timeout = 15000) {
  const r = run(real, ['task', 'list', '--json'], { env, timeout });
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() };
  try {
    return { tasks: JSON.parse(r.stdout).tasks };
  } catch {
    return { error: 'unparseable JSON from task list' };
  }
}

export function hashCallback(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

// Fail-closed scan for status callbacks, which Backlog.md runs through a shell.
// Raw frontmatter is the only source: --json output omits onStatusChange.
export function callbacksFor(ctx, taskFile) {
  const found = [];
  const { config } = boardPaths(ctx);
  const value = readConfig(config).onStatusChange;
  if (value) found.push({ where: 'config', value });
  if (taskFile) {
    const fm = parseFrontmatter(fs.readFileSync(taskFile, 'utf8'));
    if (fm.onStatusChange) found.push({ where: path.basename(taskFile), value: fm.onStatusChange });
  }
  return found;
}

export function allCallbacks(ctx) {
  const { dir } = boardPaths(ctx);
  const found = callbacksFor(ctx, null);
  for (const folder of ['tasks', 'drafts']) {
    const full = path.join(dir, folder);
    if (!exists(full)) continue;
    for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.md'))) {
      const fm = parseFrontmatter(fs.readFileSync(path.join(full, f), 'utf8'));
      if (fm.onStatusChange) found.push({ where: f, value: fm.onStatusChange });
    }
  }
  return found;
}
