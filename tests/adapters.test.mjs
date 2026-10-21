import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { buildInvocation, OutputCollector, parseReport } from '../server/adapters.mjs';
import { validProxy, resolveInside, redact, manifest } from '../server/safety.mjs';
import { temporary, cleanup, success } from './helpers.mjs';

test('Antigravity receives an explicit workspace, isolated permissions and exact prompt', () => {
  const root = temporary();
  try {
    const prompt = '中文 "引号"\n& whoami; no shell execution';
    const invocation = buildInvocation({ provider: 'antigravity', executable: process.execPath,
      permission: 'plan', model: 'test', prefixArgs: [path.resolve('tests/fixtures/fake-dsh.mjs')] }, prompt,
    { workspace: root, logFile: path.join(root, 'log'), conversationId: 'session-1' });
    assert.equal(invocation.args[invocation.args.indexOf('--print') + 1], prompt);
    assert.equal(invocation.args[invocation.args.indexOf('--add-dir') + 1], root);
    assert.equal(invocation.args[invocation.args.indexOf('--mode') + 1], 'plan');
    assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(invocation.args[invocation.args.indexOf('--conversation') + 1], 'session-1');
  } finally { cleanup(root); }
});

test('real soft-deny event remains a failure even with exit zero and SUCCESS', () => {
  const root = temporary();
  try {
    const collector = new OutputCollector('antigravity', root);
    collector.line(JSON.stringify({ event: 'step_update', step_update: { state: 'ERROR', step_type: 'tool',
      tool_info: { name: 'view_file', error: { message: 'permission check failed for read_file: user denied permission' } } } }));
    collector.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: success().response } }));
    const result = collector.finish(0);
    assert.equal(result.success, false);
    assert.ok(result.riskFlags.includes('permission_denied'));
  } finally { cleanup(root); }
});

test('missing terminal result and invalid structured answer cannot succeed', () => {
  const root = temporary();
  try {
    const collector = new OutputCollector('antigravity', root);
    collector.line('not json');
    const result = collector.finish(0);
    assert.ok(result.riskFlags.includes('missing_terminal_event'));
    assert.ok(result.riskFlags.includes('unstructured_report'));
    assert.equal(parseReport('{"summary":"ok","status":"made-up"}'), null);
  } finally { cleanup(root); }
});

test('Antigravity concatenated schema frames use the last validated report', () => {
  const report = success('最终报告').report;
  const earlier = { ...report, summary: '先前报告', handoff: {} };
  const response = `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n${JSON.stringify(earlier)}\n${JSON.stringify({ ...report, toolAction: 'Finish' })}\n`;
  assert.equal(parseReport(response).summary, '最终报告');
  assert.equal(parseReport(`${response}${JSON.stringify(earlier)}`), null);
});

test('Antigravity keeps nested and flat text deltas when the terminal frame omits the answer', () => {
  const response = JSON.stringify(success('中文 空格\n第二行').report, null, 2);
  for (const nested of [true, false]) {
    for (const terminalResponse of [undefined, '', null]) {
      const collector = new OutputCollector('antigravity', process.cwd());
      const frame = (event, data) => JSON.stringify(nested ? { event, [event]: data } : { event, ...data });
      collector.line(frame('init', { conversation_id: 'stream-session' }));
      for (let index = 0; index < response.length; index += 7) {
        collector.line(frame('step_update', { step_type: 'text', text_delta: response.slice(index, index + 7) }));
      }
      collector.line(frame('result', { status: 'SUCCESS', response: terminalResponse, usage: { total_tokens: 42 } }));
      const result = collector.finish(0);
      assert.equal(result.response, response);
      assert.equal(result.conversationId, 'stream-session');
      assert.equal(result.report.summary, '中文 空格\n第二行');
      assert.equal(result.usage.total_tokens, 42);
      assert.equal(result.success, true);
    }
  }
});

test('Antigravity final answer replaces deltas without duplicating the report', () => {
  const collector = new OutputCollector('antigravity', process.cwd());
  collector.line(JSON.stringify({ event: 'step_update', text_delta: success('旧内容').response }));
  collector.line(JSON.stringify({ event: 'result', status: 'SUCCESS', response: success('最终内容').response }));
  assert.equal(collector.finish(0).response, success('最终内容').response);
});

test('Antigravity streamed reports still require an explicit successful terminal and process exit', () => {
  for (const terminal of [null, {}, { status: 'ERROR' }, { status: 'SUCCESS' }]) {
    for (const exitCode of [0, 1]) {
      const collector = new OutputCollector('antigravity', process.cwd());
      collector.line(JSON.stringify({ event: 'step_update', step_update: { text_delta: success().response } }));
      if (terminal) collector.line(JSON.stringify({ event: 'result', result: terminal }));
      const result = collector.finish(exitCode);
      assert.equal(result.success, terminal?.status === 'SUCCESS' && exitCode === 0);
      assert.equal(result.riskFlags.includes('missing_terminal_event'), terminal === null);
      assert.ok(result.response.length > 0);
    }
  }
  const unstructured = new OutputCollector('antigravity', process.cwd());
  unstructured.line(JSON.stringify({ event: 'step_update', text_delta: '已经完成了' }));
  unstructured.line(JSON.stringify({ event: 'result', status: 'SUCCESS' }));
  assert.ok(unstructured.finish(0).riskFlags.includes('unstructured_report'));
});

test('Antigravity flat tool denials, invalid JSON values and oversized deltas remain guarded', () => {
  const collector = new OutputCollector('antigravity', process.cwd());
  for (const value of ['null', 'false', '[]']) collector.line(value);
  collector.line(JSON.stringify({ event: 'step_update', step_type: 'tool', state: 'DENIED',
    tool_info: { name: 'write_to_file', parameters: { TargetFile: path.resolve(process.cwd(), '..', 'escape.txt') } } }));
  collector.line(JSON.stringify({ event: 'step_update', text_delta: 'x'.repeat(65000) }));
  collector.line(JSON.stringify({ event: 'result', status: 'SUCCESS', response: success().response }));
  const result = collector.finish(0);
  assert.equal(collector.malformed, 3);
  assert.equal(result.success, false);
  for (const flag of ['permission_denied', 'out_of_scope_write', 'output_limit']) assert.ok(result.riskFlags.includes(flag));
});

test('Antigravity completion cannot be supplied or overwritten by another provider protocol', () => {
  const missing = new OutputCollector('antigravity', process.cwd());
  missing.line(JSON.stringify({ event: 'step_update', text_delta: success().response }));
  missing.line(JSON.stringify({ type: 'turn.completed' }));
  assert.ok(missing.finish(0).riskFlags.includes('missing_terminal_event'));
  const mixed = new OutputCollector('antigravity', process.cwd());
  mixed.line(JSON.stringify({ event: 'result', type: 'result', result: { status: 'ERROR', response: success().response } }));
  mixed.line(JSON.stringify({ type: 'turn.completed' }));
  const result = mixed.finish(0);
  assert.equal(result.success, false);
  assert.ok(result.riskFlags.includes('provider_error'));
  assert.match(result.error, /未确认成功/);
});

test('out-of-scope file tool writes are identified', () => {
  const root = temporary();
  try {
    const collector = new OutputCollector('antigravity', root);
    collector.line(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: path.join(root, '..', 'escape.txt') } } } }));
    assert.ok(collector.riskFlags.has('out_of_scope_write'));
  } finally { cleanup(root); }
});

test('path traversal, unsafe proxies and bypass arguments are rejected', () => {
  const root = temporary();
  try {
    assert.throws(() => resolveInside(root, '../escape'));
    assert.throws(() => validProxy('http://user:password@127.0.0.1:7897'));
    assert.throws(() => validProxy('https://example.test/path'));
    assert.equal(validProxy('http://127.0.0.1:7897'), 'http://127.0.0.1:7897');
    assert.throws(() => buildInvocation({ provider: 'custom', executable: process.execPath,
      inputMode: 'stdin', prefixArgs: ['--dangerously-skip-permissions'] }, 'hello', { workspace: root }));
  } finally { cleanup(root); }
});

test('manifest ties evidence to content and excludes private downloads', () => {
  const root = temporary();
  try {
    fs.writeFileSync(path.join(root, 'file.txt'), 'first');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
    const first = manifest(root);
    fs.writeFileSync(path.join(root, 'file.txt'), 'second');
    assert.notEqual(manifest(root).revision, first.revision);
    assert.equal(manifest(root, { includePrivate: false }).files.some((file) => file.name === '.env'), false);
    assert.equal(redact('Bearer my_secret_token_value'), 'Bearer [REDACTED]');
  } finally { cleanup(root); }
});
test('Antigravity startup errors preserve the redacted diagnosis instead of an empty report', () => {
  const collector = new OutputCollector('antigravity', process.cwd());
  collector.line(JSON.stringify({ event: 'result', result: {
    conversation_id: '', status: 'ERROR', response: '',
    error: 'Eligibility check failed: loadCodeAssist: EOF; api_key=private-value',
    usage: { total_tokens: 0 },
  } }));
  const result = collector.finish(1);
  assert.equal(result.success, false);
  assert.ok(result.riskFlags.includes('provider_error'));
  assert.match(result.error, /Eligibility check failed.*EOF/);
  assert.ok(!result.error.includes('private-value'));
  assert.equal(result.conversationId, null);
  assert.equal(result.usage.total_tokens, 0);
});
