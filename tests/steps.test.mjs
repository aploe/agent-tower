import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepLabel, askSummary, questionsOf, planSummary, buildSteps } from '../src/steps.mjs';

test('stepLabel', () => {
  assert.equal(stepLabel('Bash', { command: 'npm test', description: 'Run the test suite' }), 'Run the test suite');
  assert.equal(stepLabel('Bash', { command: 'x'.repeat(200) }), 'x'.repeat(80));
  assert.equal(stepLabel('Edit', { file_path: '/a/b/cookie-notice.php' }), 'cookie-notice.php');
  assert.equal(stepLabel('Agent', { description: 'Review the diff' }), 'Review the diff');
  assert.equal(stepLabel('Skill', { skill: 'superpowers:brainstorming' }), 'superpowers:brainstorming');
  assert.equal(stepLabel('WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }), 'code.claude.com');
  assert.equal(stepLabel('WebSearch', { query: 'agent huddle' }), 'agent huddle');
  assert.equal(stepLabel('Grep', { pattern: 'TodoWrite' }), 'TodoWrite');
  assert.equal(stepLabel('Glob', { pattern: '**/*.mjs' }), '**/*.mjs');
  assert.equal(stepLabel('Read', { file_path: '/a/b/c.txt' }), 'c.txt');
  assert.equal(stepLabel('ToolSearch', {}), 'ToolSearch');
  assert.equal(stepLabel('Bash', null), 'Bash');
  assert.equal(stepLabel('WebFetch', { url: 'not a url' }), 'WebFetch');
  assert.equal(stepLabel('Edit', { file_path: 42 }), 'Edit');
});

test('askSummary', () => {
  assert.equal(askSummary('Bash', { command: 'rm -rf scratchpad/tmp' }), 'rm -rf scratchpad/tmp');
  assert.equal(askSummary('Write', { file_path: '/a/b.txt' }), '/a/b.txt');
  assert.equal(askSummary('Edit', { file_path: '/a/c.txt' }), '/a/c.txt');
  assert.equal(askSummary('NotebookEdit', { file_path: '/a/n.ipynb' }), '/a/n.ipynb');
  assert.equal(askSummary('WebFetch', { url: 'https://example.org/x' }), 'https://example.org/x');
  assert.equal(askSummary('Bash', { command: 'y'.repeat(500) }).length, 200);
  assert.equal(askSummary('Other', { a: 1 }), '{"a":1}');
  assert.equal(askSummary('Other', null), null);
  assert.equal(askSummary('Bash', null), null);
});

test('questionsOf keeps question, header, option labels and multiSelect; null for anything else', () => {
  const input = {
    questions: [
      { question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'a' }, 'B'] },
      { question: 'Second?', options: [] },
    ],
  };
  assert.deepEqual(questionsOf(input), [
    { question: 'Which?', header: 'Pick', options: ['A', 'B'], multiSelect: true },
    { question: 'Second?', header: '', options: [], multiSelect: false },
  ]);
  assert.equal(questionsOf(null), null);
  assert.equal(questionsOf({}), null);
  assert.equal(questionsOf({ questions: 'x' }), null);
  assert.equal(questionsOf({ questions: [null] }), null);
  assert.equal(questionsOf({ questions: [{ header: 'h' }] }), null);
  assert.equal(questionsOf({ questions: [{ question: 'q', options: [{ nolabel: 1 }] }] }), null);
});

test('planSummary is the first non-empty line of input.plan, capped at 200', () => {
  assert.equal(planSummary({ plan: '\n\n  # Title  \nbody' }), '# Title');
  assert.equal(planSummary({ plan: 'z'.repeat(300) }).length, 200);
  assert.equal(planSummary({ plan: '  \n ' }), null);
  assert.equal(planSummary({}), null);
  assert.equal(planSummary(null), null);
});

function call(i, name, input, extra = {}) {
  return { id: 't' + i, name, input, atMs: 1_000_000 + i, status: 'done', resultText: null, ...extra };
}

test('buildSteps keeps the last 15 in file order and fills the terminal from the last Bash call', () => {
  const calls = [];
  for (let i = 0; i < 18; i++) calls.push(call(i, 'Grep', { pattern: 'p' + i }));
  calls.push(call(18, 'Bash', { command: 'npm test' }, { resultText: 'a\n\nℹ pass 41\n' }));
  calls.push(call(19, 'Read', { file_path: '/x/y.js' }, { status: 'running', atMs: null }));
  const out = buildSteps(calls);
  assert.equal(out.steps.length, 15);
  assert.equal(out.steps[0].label, 'p5');
  assert.deepEqual(out.steps[14], { tool: 'Read', label: 'y.js', status: 'running', at: null });
  assert.equal(out.steps[13].at, new Date(1_000_018).toISOString());
  assert.deepEqual(out.terminal, { command: 'npm test', lastLine: 'ℹ pass 41' });
  assert.equal(buildSteps(calls, 3).steps.length, 3);
});

test('terminal caps: command 200, lastLine 160; no Bash call gives null', () => {
  const out = buildSteps([call(0, 'Bash', { command: 'c'.repeat(300) }, { resultText: 'l'.repeat(300) })]);
  assert.equal(out.terminal.command.length, 200);
  assert.equal(out.terminal.lastLine.length, 160);
  assert.equal(buildSteps([call(0, 'Read', { file_path: '/a' })]).terminal, null);
  assert.equal(buildSteps([]).terminal, null);
  const pending = buildSteps([call(0, 'Bash', { command: 'ls' }, { status: 'running' })]);
  assert.deepEqual(pending.terminal, { command: 'ls', lastLine: null });
});
