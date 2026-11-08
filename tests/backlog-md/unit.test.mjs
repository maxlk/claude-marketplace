import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, scan } from '../../plugins/backlog-md/lib/scan.mjs';
import { classify, createModel, editModel, parseCreate, parseEdit } from '../../plugins/backlog-md/lib/argv.mjs';
import { evaluate, stagesFor } from '../../plugins/backlog-md/lib/policy.mjs';
import { inferClasses, validateStatuses } from '../../plugins/backlog-md/lib/setup.mjs';
import { parseConfig, taskFromFile } from '../../plugins/backlog-md/lib/board.mjs';

test('scanner accepts simple and quoted commands', () => {
  assert.deepEqual(scan('backlog task list --plain').tokens, ['backlog', 'task', 'list', '--plain']);
  assert.deepEqual(scan(`backlog task create "A title" -d 'has; $(x) inside'`).tokens.slice(3), ['A title', '-d', 'has; $(x) inside']);
  assert.deepEqual(scan(`backlog task edit 1 --plan $'a\\nb'`).simple, true);
});

test('scanner rejects anything that could run something else', () => {
  for (const c of ['backlog task list; rm -rf /', 'backlog task list | sh', 'backlog task list && x', 'FOO=1 backlog task list', 'backlog task create "$(id)"', 'backlog task create "`id`"', 'backlog task list > /etc/x', 'backlog task create `id`', 'backlog task list\nrm x', 'backlog task create $HOME', 'backlog task list &', "backlog 'unterminated"]) {
    assert.equal(scan(c).simple, false, c);
  }
});

test('command classification', () => {
  const c = (s) => classifyCommand(scan(s).tokens);
  assert.equal(c('backlog task list --plain'), 'read');
  assert.equal(c('backlog task 12 --plain'), 'read');
  assert.equal(c('backlog task create x'), 'write');
  assert.equal(c('backlog task delete 1'), null);
  assert.equal(c('backlog config set autoCommit true'), null);
  assert.equal(c('backlog config get statuses'), 'read');
  assert.equal(c('backlog doctor --fix --yes'), null);
  assert.equal(c('backlog-md approve TASK-1'), null);
  assert.equal(c('backlog-md status'), 'read');
  assert.equal(c('rm backlog'), null);
});

test('argv forms understood the way the CLI understands them', () => {
  const p = parseEdit(['2', '--priority', 'high', '1', '--status=done', '-a@x', '--check-ac', '1', '--check-ac', '2,3']);
  assert.deepEqual(p.positional, ['2', '1']);
  assert.equal(p.options.status, 'done');
  assert.equal(p.options.priority, 'high');
  assert.deepEqual(p.options.assignee, ['@x']);
  assert.deepEqual(p.options.checkAc, ['1', '2,3']);
  assert.deepEqual(parseEdit(['1', '--mystery', 'v']).unknown, ['--mystery']);
  assert.equal(classify(['tasks', 'create', 'x']).kind, 'task-create');
  assert.equal(classify(['draft', 'promote', '1']).kind, 'draft-promote');
  assert.equal(classify(['task', '12']).kind, 'other');
  assert.equal(parseCreate(['x', '-s"in progress"'.replace(/"/g, '')]).options.status, 'in progress');
});

test('edit merge models post-edit state', () => {
  const task = { acceptanceCriteria: [{ text: 'a', checked: false }, { text: 'b', checked: false }], definitionOfDone: [], labels: ['x'], references: [], documentation: [], finalSummary: null, implementationPlan: 'p' };
  const m = editModel(task, { checkAc: ['1,2'], addLabel: ['y'], removeLabel: ['x'], finalSummary: 'done', appendPlan: ['more'] });
  assert.ok(m.acceptanceCriteria.every((a) => a.checked));
  assert.deepEqual(m.labels, ['y']);
  assert.equal(m.finalSummary, 'done');
  assert.equal(m.implementationPlan, 'p\n\nmore');
  assert.deepEqual(editModel(task, { clearAc: true }).acceptanceCriteria, []);
  assert.deepEqual(editModel(task, { removeAc: ['1'], addAc: ['c'] }).acceptanceCriteria.map((a) => a.text), ['b', 'c']);
  assert.equal(editModel({ ...task, milestone: 'm' }, { clearMilestone: true }).milestone, null);
});

test('create model applies Definition of Done defaults', () => {
  const cfg = { definition_of_done: ['Tests'], default_status: 'Backlog' };
  assert.equal(createModel({}, cfg).status, 'Backlog');
  assert.equal(createModel({}, cfg).definitionOfDone.length, 1);
  assert.equal(createModel({ noDodDefaults: true, dod: ['x', 'y'] }, cfg).definitionOfDone.length, 2);
});

test('gates: levels, ops, conditions and cumulative stages', () => {
  const policy = {
    enforcement: { create: 'warn', start: 'off', finish: 'block' },
    gates: {
      create: [{ field: 'description', op: 'present' }, { field: 'labels', op: 'subsetOf', source: 'config.labels' }],
      start: [{ field: 'implementationPlan', op: 'present' }],
      finish: [{ field: 'acceptanceCriteria', op: 'allChecked' }, { field: 'modifiedFiles', op: 'minCount', value: 1, whenNot: { type: ['docs'] } }],
    },
  };
  const env = { config: { labels: ['bug'] }, milestones: [] };
  const task = { labels: ['nope'], acceptanceCriteria: [{ checked: false }], modifiedFiles: [], type: 'feature' };
  const v = evaluate(policy, task, stagesFor('terminal'), env);
  assert.deepEqual(v.map((x) => [x.key, x.level]), [['create:description:present', 'warn'], ['create:labels:subsetOf', 'warn'], ['finish:acceptanceCriteria:allChecked', 'block'], ['finish:modifiedFiles:minCount', 'block']]);
  assert.equal(evaluate(policy, { ...task, type: 'docs', acceptanceCriteria: [] }, ['finish'], env).length, 0);
});

test('status helpers', () => {
  assert.deepEqual(inferClasses(['Inbox', 'Doing', 'Shipped'], 'Inbox'), { queued: ['Inbox'], active: ['Doing'], terminal: ['Shipped'] });
  assert.equal(validateStatuses(['A', 'a']).length, 1);
  assert.match(validateStatuses(['Draft', 'Done'])[0], /reserved/);
  assert.equal(validateStatuses(['A']).length, 1);
  assert.equal(validateStatuses(['A', 'B']).length, 0);
});

test('config parser handles flow and block lists', () => {
  const c = parseConfig('statuses: ["To Do", \'In, Progress\', Done]\nlabels:\n  - a\n  - "b"\nname: "x"\nempty: []\n');
  assert.deepEqual(c.statuses, ['To Do', 'In, Progress', 'Done']);
  assert.deepEqual(c.labels, ['a', 'b']);
  assert.equal(c.name, 'x');
  assert.deepEqual(c.empty, []);
});

test('task file parser', () => {
  const raw = `---\nid: DRAFT-1\ntitle: t\nstatus: Draft\nassignee: []\nlabels: [a]\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nhello\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [x] #1 a\n- [ ] #2 b\n<!-- AC:END -->\n`;
  const t = taskFromFile(raw);
  assert.equal(t.description, 'hello');
  assert.deepEqual(t.acceptanceCriteria.map((a) => a.checked), [true, false]);
  assert.deepEqual(t.labels, ['a']);
});
