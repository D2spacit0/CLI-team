import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

test('HTTP delegation traverses real CLI reports, worker files, integration, node test gate and manual acceptance', async () => {
  const f = fixture();
  const app = createApp(f.service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const cliPath = fileURLToPath(new URL('./fixtures/delegation-cli.mjs', import.meta.url));
    const cliConfig = { prefixArgs: [cliPath], inputMode: 'stdin' };
    f.service.saveMember(cliConfig, f.builder.id);
    f.service.saveMember(cliConfig, f.reviewer.id);
    const member = f.service.saveMember({ name: '模块专家', handle: 'module-worker', provider: 'custom',
      executable: process.execPath, permission: 'edit', enabled: true, role: 'builder', skills: '编写可测试的 ESM 模块', ...cliConfig });
    f.service.updateSettings({ repairLimit: 0 });
    const response = await post('/api/tasks', { title: '真实进程协作协议测试', objective: '协作者提供模块，负责人完成集成',
      executionMode: 'delegated', assigneeId: f.builder.id, participantIds: [member.id], reviewerId: f.reviewer.id,
      verification: { executable: process.execPath, args: ['--test', 'acceptance.test.mjs'] }, start: false });
    assert.equal(response.status, 201);
    const task = await response.json();
    // Independent acceptance criteria exist before agents run; the fixture cannot manufacture its gate.
    fs.writeFileSync(path.join(task.workspace, 'acceptance.test.mjs'), [
      'import test from "node:test";', 'import assert from "node:assert/strict";',
      'import { doubled } from "./integrated.mjs";',
      'test("integrated worker value", () => assert.equal(doubled, 42));', '',
    ].join('\n'));
    assert.equal((await post(`/api/tasks/${task.id}/start`, {})).status, 200);
    const terminal = await until(() => {
      const current = f.service.require('tasks', task.id);
      return ['review', 'blocked'].includes(current.status) && current;
    }, 60000);
    assert.equal(terminal.status, 'review', JSON.stringify(f.service.store.list('runs').map((run) => ({
      stage: run.stage, summary: run.summary, flags: run.riskFlags,
      output: fs.existsSync(run.streamLog) ? fs.readFileSync(run.streamLog, 'utf8') : '',
    }))));
    assert.equal(terminal.gate.status, 'passed');
    assert.equal(f.service.require('evidence', terminal.gate.evidenceId).testCount, 1);
    assert.equal(terminal.reviewVerdict, 'approve');
    const runs = f.service.store.list('runs').filter((run) => run.taskId === task.id);
    assert.equal(runs.length, 4);
    assert.ok(runs.every((run) => run.status === 'succeeded' && run.exitCode === 0));
    assert.equal(runs.find((run) => run.stage === 'plan').report.delegation.steps[0].memberId, member.id);
    assert.equal(terminal.coordination.steps[0].status, 'succeeded');
    const accepted = await post(`/api/tasks/${task.id}/accept`, { note: '验收模块结果与测试证据完成' });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).status, 'done');
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});
