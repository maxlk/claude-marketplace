// Conservative, quote-aware reader of a shell command. Used only to decide
// whether to skip a permission prompt; enforcement lives in the shim.
export function scan(command) {
  const tokens = [];
  let cur = '';
  let inToken = false;
  const fail = { simple: false, tokens: [] };
  const n = command.length;
  for (let i = 0; i < n; i += 1) {
    const c = command[i];
    if (c === ' ' || c === '\t') {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return fail;
      cur += command.slice(i + 1, end);
      inToken = true;
      i = end;
    } else if (c === '"') {
      inToken = true;
      let j = i + 1;
      for (; j < n && command[j] !== '"'; j += 1) {
        if (command[j] === '$' || command[j] === '`') return fail;
        if (command[j] === '\\') j += 1;
        cur += command[j];
      }
      if (j >= n) return fail;
      i = j;
    } else if (c === '$' && command[i + 1] === "'") {
      inToken = true;
      let j = i + 2;
      for (; j < n && command[j] !== "'"; j += 1) {
        if (command[j] === '\\') j += 1;
        cur += command[j];
      }
      if (j >= n) return fail;
      i = j;
    } else if ('\n\r;|&<>()`$*?[]{}~#!'.includes(c)) {
      return fail;
    } else if (c === '\\') {
      if (i + 1 >= n || command[i + 1] === '\n') return fail;
      cur += command[(i += 1)];
      inToken = true;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  if (tokens.length === 0 || tokens[0].includes('=')) return fail;
  return { simple: true, tokens };
}

const READ_TOP = new Set(['board', 'search', 'overview', 'instructions']);
const READ_SUB = { doc: ['list', 'view'], decision: ['list', 'view'], draft: ['list', 'view'], milestone: ['list'], milestones: ['list'], config: ['get', 'list'] };
const READ_ADMIN = new Set(['status', 'policy', 'detect', 'presets', 'shell-init', 'audit']);

// Returns 'read', 'write', or null when the command deserves a normal prompt.
export function classifyCommand(tokens) {
  const [bin, a, b] = tokens;
  if (bin === 'backlog-md') {
    if (READ_ADMIN.has(a)) return 'read';
    if (a === 'sync' && b === '--status') return 'read';
    if (a === 'doctor' && !tokens.includes('--fix')) return 'read';
    return null;
  }
  if (bin !== 'backlog') return null;
  if (a === '--version' || a === '-v' || a === '--help' || a === 'help') return 'read';
  if (a === 'board' && (b === 'export' || tokens.includes('--force'))) return null;
  if (READ_TOP.has(a)) return 'read';
  if (a === 'doctor') return tokens.includes('--fix') ? null : 'read';
  if (a === 'task' || a === 'tasks') {
    if (b === 'list' || b === 'view' || /^([A-Za-z]+-)?\d/.test(b ?? '')) return 'read';
    if (b === 'create' || b === 'edit') return 'write';
    return null;
  }
  if (a === 'draft' && (b === 'create' || b === 'edit')) return 'write';
  if (a === 'milestone' && b === 'add') return 'write';
  if (READ_SUB[a]?.includes(b)) return 'read';
  return null;
}
