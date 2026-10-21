import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = path.resolve(projectRoot, 'work');
const task = {
  id: 'task-example', title: '协作任务', objective: 'PRIVATE_OBJECTIVE_OMITTED',
  workspace: 'task-workspace', status: 'blocked', executionMode: 'delegated',
  assigneeId: 'owner', participantIds: ['worker'],
  summary: '协作答复已保存，点击继续任务后恢复执行',
  report: { summary: 'PRIVATE_FULL_REPORT_OMITTED' },
};

async function controllerFixture(t) {
  fs.mkdirSync(workRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(workRoot, 'controller-assistance-'));
  const requests = [];
  let statusCode = 200;
  let response = task;
  const server = http.createServer(async (request, result) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url,
      authenticated: request.headers.authorization === 'Bearer fixture-controller',
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined });
    result.writeHead(statusCode, { 'Content-Type': 'application/json' });
    result.end(JSON.stringify(response));
  });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(directory)), workRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  fs.mkdirSync(path.join(directory, '.team'));
  fs.writeFileSync(path.join(directory, '.team', 'server.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
  fs.writeFileSync(path.join(directory, '.team', 'controller.token'), 'fixture-controller');
  return { directory, requests,
    respond: (code, body) => { statusCode = code; response = body; } };
}

function cli(f, args) {
  return execute(process.execPath, [path.join(projectRoot, 'tools', 'team.mjs'), ...args], {
    cwd: projectRoot, env: { ...process.env, CLI_TEAM_WORKSPACE: f.directory },
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
}

function assertCompactTask(text) {
  const receipt = JSON.parse(text);
  assert.equal(receipt.id, task.id);
  assert.equal(receipt.status, 'blocked');
  assert.match(receipt.summary, /已保存.*继续任务/);
  assert.equal(receipt.objective, undefined);
  assert.equal(receipt.report, undefined);
  assert.ok(Buffer.byteLength(text) < 2000);
}

test('CLI saves the exact assistance answer via one encoded POST without starting work', { timeout: 15000 }, async (t) => {
  const f = await controllerFixture(t);
  const taskId = 'task-空间/?', helpId = 'help-条目/#';
  const answer = '第一行：使用 status = "ready"\n第二行：保留空格 & 原文。';
  const result = await cli(f, ['answer', taskId, '--help-id', helpId, '--answer', `  ${answer}  `]);
  assert.equal(result.stderr, '');
  assertCompactTask(result.stdout);
  assert.deepEqual(f.requests, [{ method: 'POST', authenticated: true,
    url: `/api/tasks/${encodeURIComponent(taskId)}/assistance/${encodeURIComponent(helpId)}/answer`, body: { answer } }]);
});

test('CLI rejects missing or invalid answer arguments before contacting the service', { timeout: 15000 }, async (t) => {
  const f = await controllerFixture(t);
  const invalid = [
    ['answer', '--help-id', 'help-1', '--answer', '答复'],
    ['answer', 'task-1', '--answer', '答复'],
    ['answer', 'task-1', '--help-id', 'help-1'],
    ['answer', 'task-1', '--help-id', '   ', '--answer', '答复'],
    ['answer', 'task-1', '--help-id', 'help-1', '--answer', '  \n  '],
    ['answer', 'task-1', '--help-id', 'help-1', '--answer', 'x'.repeat(6001)],
  ];
  for (const args of invalid) {
    await assert.rejects(cli(f, args), (error) => {
      assert.equal(error.code, 1);
      assert.match(JSON.parse(error.stderr).error, /需要 answer|不能超过 6000/);
      return true;
    });
  }
  assert.deepEqual(f.requests, []);
});

test('CLI preserves a rejected assistance response and does not fall through to start', { timeout: 15000 }, async (t) => {
  const f = await controllerFixture(t);
  f.respond(409, { error: '只能答复当前计划中等待处理的协作问题' });
  await assert.rejects(cli(f, ['answer', 'task-1', '--help-id', 'help-1', '--answer', '答复']), (error) => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stderr).error, /当前计划/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /\/assistance\/help-1\/answer$/);
});

test('MCP validates and saves assistance answers with compact receipts and no implicit start', { timeout: 20000 }, async (t) => {
  const f = await controllerFixture(t);
  const client = new Client({ name: 'assistance-controller-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(projectRoot, 'tools', 'mcp.mjs')], cwd: projectRoot,
    env: { CLI_TEAM_WORKSPACE: f.directory }, stderr: 'pipe' });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const registered = tools.tools.find((item) => item.name === 'team_answer_assistance');
    assert.ok(registered);
    assert.match(registered.description, /does not start/);
    for (const answer of ['', '   ', 'x'.repeat(6001)]) {
      const invalid = await client.callTool({ name: registered.name, arguments: { taskId: 'task-1', helpId: 'help-1', answer } });
      assert.equal(invalid.isError, true);
    }
    assert.equal(f.requests.length, 0);
    const answer = '按用户确认的字段继续；保留上一步结果。';
    const result = await client.callTool({ name: registered.name,
      arguments: { taskId: 'task-空间/?', helpId: 'help-条目/#', answer: ` ${answer} ` } });
    assert.notEqual(result.isError, true);
    assertCompactTask(result.content[0].text);
    assert.deepEqual(f.requests, [{ method: 'POST', authenticated: true,
      url: `/api/tasks/${encodeURIComponent('task-空间/?')}/assistance/${encodeURIComponent('help-条目/#')}/answer`, body: { answer } }]);
    f.respond(409, { error: '成员或验收仍在停止中，请稍后保存答复' });
    const rejected = await client.callTool({ name: registered.name,
      arguments: { taskId: 'task-1', helpId: 'help-1', answer } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /仍在停止中/);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every((request) => request.url.endsWith('/answer')));
  } finally { await client.close(); }
});
