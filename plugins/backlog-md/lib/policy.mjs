// Evaluates mandatory-field gates. Backlog.md itself only requires a title.
import { milestoneExists } from './board.mjs';

const STAGE_ORDER = ['create', 'start', 'finish'];
const CLASS_RANK = { queued: 0, active: 1, terminal: 2 };

export const FIELD_HELP = {
  description: { label: 'description', flag: '-d "<text>"' },
  acceptanceCriteria: { label: 'acceptance criteria', flag: '--ac "<criterion>"', check: '--check-ac <n>' },
  definitionOfDone: { label: 'Definition of Done', flag: '--dod "<item>"', check: '--check-dod <n>' },
  assignees: { label: 'assignee', flag: '-a @name' },
  labels: { label: 'labels', flag: '-l <label>' },
  priority: { label: 'priority', flag: '--priority <High|Medium|Low>' },
  type: { label: 'type', flag: '--type <type>' },
  project: { label: 'project', flag: '--project <project>' },
  milestone: { label: 'milestone', flag: '-m "<milestone>"' },
  dueDate: { label: 'due date', flag: '--due-date YYYY-MM-DD' },
  parentTaskId: { label: 'parent task', flag: '-p <taskId>' },
  references: { label: 'references', flag: '--ref <url-or-path>' },
  documentation: { label: 'documentation', flag: '--doc <url-or-path>' },
  modifiedFiles: { label: 'modified files', flag: '--modified-file <path>' },
  implementationPlan: { label: 'implementation plan', flag: '--plan "<text>"' },
  implementationNotes: { label: 'implementation notes', flag: '--notes "<text>"' },
  finalSummary: { label: 'final summary', flag: '--final-summary "<text>"' },
};

export function classOf(policy, status) {
  if (!status) return null;
  const s = status.toLowerCase();
  for (const [cls, names] of Object.entries(policy.statusClasses ?? {})) {
    if (names.some((n) => n.toLowerCase() === s)) return cls;
  }
  return null;
}

export function rankOf(cls) {
  return cls ? CLASS_RANK[cls] : -1;
}

export function stagesFor(cls) {
  if (cls === 'terminal') return STAGE_ORDER;
  if (cls === 'active') return STAGE_ORDER.slice(0, 2);
  if (cls === 'queued') return STAGE_ORDER.slice(0, 1);
  return [];
}

export function enforcementFor(policy, stage) {
  const e = policy.enforcement;
  if (typeof e === 'string') return e;
  return e?.[stage] ?? 'off';
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function lower(v) {
  return String(v).toLowerCase();
}

function matches(actual, expected) {
  if (Array.isArray(expected)) return expected.some((e) => matches(actual, e));
  if (Array.isArray(actual)) return actual.some((a) => lower(a) === lower(expected));
  return !isEmpty(actual) && lower(actual) === lower(expected);
}

function conditionHolds(rule, task) {
  for (const [field, expected] of Object.entries(rule.when ?? {})) if (!matches(task[field], expected)) return false;
  for (const [field, expected] of Object.entries(rule.whenNot ?? {})) if (matches(task[field], expected)) return false;
  return true;
}

function sourceValues(rule, env) {
  if (rule.values) return rule.values;
  if (rule.source?.startsWith('config.')) return env.config?.[rule.source.slice(7)] ?? [];
  return [];
}

function describe(rule, task) {
  const h = FIELD_HELP[rule.field] ?? { label: rule.field, flag: `(${rule.field})` };
  if (rule.message) return rule.message;
  const value = task[rule.field];
  switch (rule.op) {
    case 'present':
      return `${h.label} is required: add ${h.flag}`;
    case 'minCount':
      return `at least ${rule.value} ${h.label} required (has ${Array.isArray(value) ? value.length : 0}): add ${h.flag}`;
    case 'maxCount':
      return `at most ${rule.value} ${h.label} allowed`;
    case 'allChecked':
      return `every ${h.label} item must be checked (use ${h.check ?? h.flag}), after confirming it is really satisfied`;
    default:
      return `${h.label} has a value that is not allowed`;
  }
}

export function checkRule(rule, task, env) {
  if (!conditionHolds(rule, task)) return true;
  const value = task[rule.field];
  switch (rule.op) {
    case 'present':
      return !isEmpty(value);
    case 'minCount':
      return (Array.isArray(value) ? value.length : isEmpty(value) ? 0 : 1) >= rule.value;
    case 'maxCount':
      return (Array.isArray(value) ? value.length : isEmpty(value) ? 0 : 1) <= rule.value;
    case 'allChecked':
      return (value ?? []).every((i) => i.checked);
    case 'in':
      if (isEmpty(value)) return false;
      if (rule.source === 'milestones') return milestoneExists(env.milestones ?? [], value);
      return sourceValues(rule, env).some((v) => lower(v) === lower(value));
    case 'subsetOf': {
      const allowed = sourceValues(rule, env).map(lower);
      return (value ?? []).every((v) => allowed.includes(lower(v)));
    }
    default:
      return true; // An unknown operator (newer policy) never blocks work.
  }
}

// Returns violations for the given stages.
export function evaluate(policy, task, stages, env) {
  const out = [];
  for (const stage of stages) {
    const stageLevel = enforcementFor(policy, stage);
    for (const rule of policy.gates?.[stage] ?? []) {
      const level = rule.level ?? stageLevel;
      if (level === 'off') continue;
      if (!checkRule(rule, task, env)) {
        out.push({ key: `${stage}:${rule.field}:${rule.op}`, stage, level, field: rule.field, message: describe(rule, task) });
      }
    }
  }
  return out;
}

export function needsApproval(policy, status, cls) {
  return (policy.transitions ?? []).some((t) => {
    if (t.approval !== 'human') return false;
    if (t.to?.startsWith('class:')) return t.to.slice(6) === cls;
    return lower(t.to) === lower(status);
  });
}

export function allowedFor(policy, env) {
  const notes = [];
  if ((env.config?.labels ?? []).length) notes.push(`labels: ${env.config.labels.join(', ')}`);
  if ((env.milestones ?? []).length) notes.push(`milestones: ${env.milestones.map((m) => m.title).join(', ')}`);
  return notes;
}

export function summarizePolicy(policy) {
  const lines = [];
  for (const stage of STAGE_ORDER) {
    const level = enforcementFor(policy, stage);
    const fields = (policy.gates?.[stage] ?? []).map((r) => {
      const name = FIELD_HELP[r.field]?.label ?? r.field;
      if (r.op === 'minCount') return `${name}>=${r.value}`;
      if (r.op === 'allChecked') return `${name} all checked`;
      if (r.op === 'subsetOf') return `${name} from allowed list`;
      if (r.op === 'in') return `${name} must exist`;
      return name;
    });
    if (fields.length && level !== 'off') lines.push(`${stage} (${level}): ${fields.join(', ')}`);
  }
  return lines;
}
