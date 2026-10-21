import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { runProcess, executeVerification } from '../server/runner.mjs';
import { temporary, cleanup } from './helpers.mjs';

test('process adapter preserves Chinese stdin and argument boundaries', async () => {
  const root = temporary();
  try {
    const result = await runProcess({ executable: process.execPath,
      args: ['-e', 'process.stdin.setEncoding("utf8");process.stdin.on("data",s=>process.stdout.write(s));'],
      stdin: '中文 "引号" & 不执行命令', cwd: root, proxy: '', timeoutMs: 3000,
      logFile: path.join(root, 'process.log') });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, '中文 "引号" & 不执行命令');
  } finally { cleanup(root); }
});

test('process timeouts terminate the child', async () => {
  const root = temporary();
  try {
    const result = await runProcess({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},20000)'],
      cwd: root, proxy: '', timeoutMs: 100, logFile: path.join(root, 'timeout.log') });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally { cleanup(root); }
});

test('zero or skipped tests do not pass an automated gate', async () => {
  const root = temporary();
  try {
    const empty = await executeVerification({ executable: process.execPath,
      args: ['-e', 'console.log("# tests 0\\n# skipped 0")'] },
    { workspace: root, proxy: '', timeoutMinutes: 1, logFile: path.join(root, 'empty.log') });
    assert.equal(empty.passed, false);
    const skipped = await executeVerification({ executable: process.execPath,
      args: ['-e', 'console.log("# tests 4\\n# skipped 1")'] },
    { workspace: root, proxy: '', timeoutMinutes: 1, logFile: path.join(root, 'skip.log') });
    assert.equal(skipped.passed, false);
    assert.equal(skipped.skipped, 1);
  } finally { cleanup(root); }
});

test('real Node spec reporter counts passing, skipped and todo tests', async () => {
  const root = temporary();
  try {
    for (const kind of ['pass', 'skip', 'todo']) {
      const filename = path.join(root, `${kind}.test.mjs`);
      fs.writeFileSync(filename, `import test from 'node:test'; test${kind === 'pass' ? '' : `.${kind}`}('case', () => {});\n`);
      const result = await executeVerification({ executable: process.execPath,
        args: ['--test', '--test-reporter=spec', filename] },
      { workspace: root, proxy: '', timeoutMinutes: 1, logFile: path.join(root, `${kind}.log`) });
      assert.equal(result.testCount, 1, JSON.stringify(result));
      assert.equal(result.passed, kind === 'pass');
      if (kind === 'skip') assert.equal(result.skipped, 1);
      if (kind === 'todo') assert.equal(result.todo, 1);
    }
  } finally { cleanup(root); }
});
