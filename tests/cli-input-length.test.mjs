import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildInvocation } from '../server/adapters.mjs';
import { executeAgent } from '../server/runner.mjs';
import { temporary, cleanup } from './helpers.mjs';

const longPrompt = '中文 "quoted" \\ boundary\n'.repeat(2500);

test('oversized argument prompts fail before invocation on Windows and remain intact elsewhere', () => {
  const root = temporary();
  try {
    for (const member of [
      { provider: 'antigravity', executable: process.execPath, permission: 'plan', prefixArgs: [path.resolve('tests/fixtures/fake-dsh.mjs')] },
      { provider: 'custom', executable: process.execPath, permission: 'plan', inputMode: 'argument', customArgs: ['{prompt}'] },
    ]) {
      const build = () => buildInvocation(member, longPrompt, { workspace: root, logFile: path.join(root, 'native.log') });
      if (process.platform === 'win32') assert.throws(build, { code: 'CLI_INPUT_TOO_LONG' });
      else assert.ok(build().args.includes(longPrompt));
    }
  } finally { cleanup(root); }
});

test('executeAgent reports oversized argv without creating a process log or starting the child on Windows', async () => {
  const root = temporary();
  try {
    const streamLog = path.join(root, 'process.log');
    const marker = path.join(root, 'started.txt');
    const member = { provider: 'custom', executable: process.execPath, permission: 'plan', inputMode: 'argument',
      prefixArgs: ['-e', 'require("node:fs").writeFileSync("started.txt", "started");console.log(JSON.stringify({summary:"ok",status:"complete"}));'],
      customArgs: ['{prompt}'] };
    const result = await executeAgent(member, longPrompt, { workspace: root, streamLog,
      logFile: path.join(root, 'native.log'), proxy: '', timeoutMinutes: 1 });
    if (process.platform === 'win32') {
      assert.equal(result.success, false);
      assert.deepEqual(result.riskFlags, ['cli_input_too_long']);
      assert.equal(result.exitCode, null);
      assert.equal(result.report, null);
      assert.equal(fs.existsSync(streamLog), false);
      assert.equal(fs.existsSync(marker), false);
    } else {
      assert.equal(result.success, true, result.error);
      assert.equal(fs.existsSync(streamLog), true);
      assert.equal(fs.existsSync(marker), true);
    }
  } finally { cleanup(root); }
});

test('long stdin prompts are preserved in full without expanding the argument list', () => {
  const root = temporary();
  try {
    const member = { provider: 'custom', executable: process.execPath, permission: 'plan', inputMode: 'stdin',
      prefixArgs: [path.resolve('tests/fixtures/fake-dsh.mjs')], customArgs: [] };
    const invocation = buildInvocation(member, longPrompt, { workspace: root });
    assert.equal(invocation.stdin, longPrompt);
    assert.deepEqual(invocation.args, member.prefixArgs);
    assert.ok(invocation.args.join(' ').length < longPrompt.length);
    assert.equal(invocation.stdin.length, longPrompt.length);
  } finally { cleanup(root); }
});
