// Models `backlog task create|edit` argv the way the CLI's parser reads it:
// --flag=value, -s"value", repeated flags, and IDs on either side of options.
const v = (key, multi = false) => ({ key, value: true, multi });
const b = (key) => ({ key, value: false });

const COMMON = {
  '-d': v('description'), '--description': v('description'), '--desc': v('description'),
  '-a': v('assignee', true), '--assignee': v('assignee', true),
  '-s': v('status'), '--status': v('status'),
  '--priority': v('priority'), '--type': v('type'), '--project': v('project'),
  '--due-date': v('dueDate'), '--plain': b('plain'),
  '--dod': v('dod', true), '--plan': v('plan'), '--notes': v('notes'),
  '--final-summary': v('finalSummary'), '--ordinal': v('ordinal'),
  '-m': v('milestone'), '--milestone': v('milestone'),
  '--depends-on': v('deps', true), '--dep': v('deps', true),
  '--ref': v('ref', true), '--modified-file': v('modifiedFile', true),
  '--doc': v('doc', true), '-h': b('help'), '--help': b('help'),
};

export const CREATE_SPEC = {
  ...COMMON,
  '-l': v('labels', true), '--labels': v('labels', true),
  '--ac': v('ac', true), '--acceptance-criteria': v('ac', true),
  '--no-dod-defaults': b('noDodDefaults'), '--draft': b('draft'),
  '-p': v('parent'), '--parent': v('parent'),
};

export const EDIT_SPEC = {
  ...COMMON,
  '-t': v('title'), '--title': v('title'),
  '-l': v('label', true), '--label': v('label', true),
  '--clear-due-date': b('clearDueDate'), '--clear-milestone': b('clearMilestone'),
  '--add-label': v('addLabel', true), '--remove-label': v('removeLabel', true), '--clear-labels': b('clearLabels'),
  '--ac': v('addAc', true), '--acceptance-criteria': v('replaceAc', true),
  '--remove-ac': v('removeAc', true), '--remove-dod': v('removeDod', true),
  '--check-ac': v('checkAc', true), '--check-dod': v('checkDod', true),
  '--uncheck-ac': v('uncheckAc', true), '--uncheck-dod': v('uncheckDod', true),
  '--clear-ac': b('clearAc'),
  '--comment': v('comment', true), '--comment-author': v('commentAuthor'),
  '--append-plan': v('appendPlan', true), '--append-notes': v('appendNotes', true),
  '--append-final-summary': v('appendFinalSummary', true), '--clear-final-summary': b('clearFinalSummary'),
  '--clear-deps': b('clearDeps'),
  '--add-ref': v('addRef', true), '--remove-ref': v('removeRef', true), '--clear-refs': b('clearRefs'),
  '--add-doc': v('addDoc', true), '--remove-doc': v('removeDoc', true), '--clear-docs': b('clearDocs'),
};

export function parseArgs(tokens, spec) {
  const options = {};
  const positional = [];
  const unknown = [];
  const set = (def, value) => {
    if (!def.value) options[def.key] = true;
    else if (def.multi) (options[def.key] ??= []).push(value);
    else options[def.key] = value;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--') {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (!t.startsWith('-') || t === '-') {
      positional.push(t);
      continue;
    }
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    const name = eq > 0 ? t.slice(0, eq) : t;
    let def = spec[name];
    let inline = eq > 0 ? t.slice(eq + 1) : undefined;
    if (!def && !t.startsWith('--') && t.length > 2 && spec[t.slice(0, 2)]?.value) {
      def = spec[t.slice(0, 2)];
      inline = t.slice(2);
    }
    if (!def) {
      unknown.push(name);
      continue;
    }
    if (!def.value) set(def);
    else if (inline !== undefined) set(def, inline);
    else if (i + 1 < tokens.length) set(def, tokens[(i += 1)]);
    else unknown.push(name);
  }
  return { options, positional, unknown };
}

// Splits top-level argv into a normalized command.
export function classify(argv) {
  const [first, second, ...rest] = argv;
  if (first === 'task' || first === 'tasks') {
    if (second === 'create') return { kind: 'task-create', tokens: rest };
    if (second === 'edit') return { kind: 'task-edit', tokens: rest };
    return { kind: 'other' };
  }
  if (first === 'draft' && second === 'promote') return { kind: 'draft-promote', tokens: rest };
  if (first === 'init') return { kind: 'init' };
  return { kind: 'other' };
}

export const parseCreate = (tokens) => parseArgs(tokens, CREATE_SPEC);
export const parseEdit = (tokens) => parseArgs(tokens, EDIT_SPEC);

const csv = (list) => (list ?? []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
const indexes = (list) => csv(list).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const items = (texts) => (texts ?? []).map((text) => ({ text, checked: false }));

export function createModel(o, config) {
  const dodDefaults = o.noDodDefaults ? [] : config.definition_of_done ?? [];
  return {
    title: '',
    status: o.status ?? config.default_status ?? null,
    description: o.description ?? null,
    assignees: o.assignee ? csv(o.assignee) : csv(config.default_assignee ? [].concat(config.default_assignee) : []),
    labels: csv(o.labels),
    priority: o.priority ?? null,
    type: o.type ?? null,
    project: o.project ?? null,
    dueDate: o.dueDate ?? null,
    milestone: o.milestone ?? null,
    parentTaskId: o.parent ?? null,
    references: csv(o.ref),
    documentation: csv(o.doc),
    modifiedFiles: o.modifiedFile ?? [],
    dependencies: csv(o.deps),
    acceptanceCriteria: items(o.ac),
    definitionOfDone: items([...dodDefaults, ...(o.dod ?? [])]),
    implementationPlan: o.plan ?? null,
    implementationNotes: o.notes ?? null,
    finalSummary: o.finalSummary ?? null,
  };
}

function applyChecks(list, check, uncheck, remove) {
  const next = list.map((x) => ({ ...x }));
  for (const i of indexes(check)) if (next[i - 1]) next[i - 1].checked = true;
  for (const i of indexes(uncheck)) if (next[i - 1]) next[i - 1].checked = false;
  const removed = new Set(indexes(remove));
  return next.filter((_, i) => !removed.has(i + 1));
}

function appendText(current, replace, appends) {
  let text = replace !== undefined ? replace : current;
  for (const a of appends ?? []) text = text ? `${text}\n\n${a}` : a;
  return text ?? null;
}

function mergeList(current, replace, add, remove, clear) {
  if (clear) return [];
  let out = replace !== undefined ? csv(replace) : [...(current ?? [])];
  for (const a of csv(add)) if (!out.includes(a)) out.push(a);
  const rm = new Set(csv(remove).map((x) => x.toLowerCase()));
  out = out.filter((x) => !rm.has(String(x).toLowerCase()));
  return out;
}

// Applies an edit's options to `task view --json` output, giving post-edit state.
export function editModel(task, o) {
  const t = { ...task };
  if (o.title !== undefined) t.title = o.title;
  if (o.status !== undefined) t.status = o.status;
  if (o.description !== undefined) t.description = o.description;
  if (o.assignee) t.assignees = csv(o.assignee);
  if (o.priority !== undefined) t.priority = o.priority;
  if (o.type !== undefined) t.type = o.type || null;
  if (o.project !== undefined) t.project = o.project || null;
  if (o.clearDueDate) t.dueDate = null;
  else if (o.dueDate !== undefined) t.dueDate = o.dueDate;
  if (o.clearMilestone) t.milestone = null;
  else if (o.milestone !== undefined) t.milestone = o.milestone;
  t.labels = mergeList(task.labels, o.label, o.addLabel, o.removeLabel, o.clearLabels);
  t.references = mergeList(task.references, o.ref, o.addRef, o.removeRef, o.clearRefs);
  t.documentation = mergeList(task.documentation, o.doc, o.addDoc, o.removeDoc, o.clearDocs);
  if (o.modifiedFile) t.modifiedFiles = [...o.modifiedFile];
  if (o.clearDeps) t.dependencies = [];
  else if (o.deps) t.dependencies = csv(o.deps);
  t.implementationPlan = appendText(task.implementationPlan, o.plan, o.appendPlan);
  t.implementationNotes = appendText(task.implementationNotes, o.notes, o.appendNotes);
  t.finalSummary = o.clearFinalSummary ? null : appendText(task.finalSummary, o.finalSummary, o.appendFinalSummary);

  let ac = (task.acceptanceCriteria ?? []).map((x) => ({ text: x.text, checked: x.checked }));
  if (o.clearAc) ac = [];
  else if (o.replaceAc) {
    const old = new Map(ac.map((x) => [x.text.trim(), x.checked]));
    ac = o.replaceAc.map((text) => ({ text, checked: old.get(text.trim()) ?? false }));
  }
  ac = applyChecks(ac, o.checkAc, o.uncheckAc, o.removeAc);
  t.acceptanceCriteria = [...ac, ...items(o.addAc)];

  const dod = applyChecks((task.definitionOfDone ?? []).map((x) => ({ text: x.text, checked: x.checked })), o.checkDod, o.uncheckDod, o.removeDod);
  t.definitionOfDone = [...dod, ...items(o.dod)];
  return t;
}
