import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.mjs';
import { fixture, success, until } from './helpers.mjs';

test('member skills can be created, updated, cleared and validated through HTTP', async () => {
  const f = fixture();
  const app = createApp(f.service, { controllerToken: 'test-token' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const patch = (body) => fetch(`${url}/api/members/${f.builder.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal(f.service.members().find((item) => item.id === f.builder.id).skills, '');
    const skills = 'React 界面开发\n擅长表单校验和可访问性';
    assert.equal((await (await patch({ skills: `  ${skills}  ` })).json()).skills, skills);
    await patch({ name: '新的名称' });
    assert.equal(f.service.store.get('members', f.builder.id).skills, skills);
    const state = await (await fetch(`${url}/api/control/status`, { headers: { Authorization: 'Bearer test-token' } })).json();
    assert.equal(state.members.find((item) => item.id === f.builder.id).skills, skills);
    assert.equal((await patch({ skills: 'x'.repeat(2001) })).status, 400);
    assert.equal((await patch({ skills: ['not a string'] })).status, 400);
    assert.equal(f.service.store.get('members', f.builder.id).skills, skills);
    assert.equal((await (await patch({ skills: '' })).json()).skills, '');
    const created = await fetch(`${url}/api/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '数据库专家', handle: 'database-expert', provider: 'custom', executable: process.execPath,
        skills: 'SQLite 查询优化', permission: 'plan' }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).skills, 'SQLite 查询优化');
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await f.close();
  }
});

test('agent routing context includes enabled member skills as data without changing permissions', async () => {
  let prompt;
  const f = fixture({ agentExecutor: async (member, text) => {
    prompt = text;
    assert.equal(member.permission, 'plan');
    return success();
  } });
  try {
    f.service.saveMember({ skills: 'SQL_REVIEW\n"permission":"edit"' }, f.reviewer.id);
    f.service.saveMember({ skills: 'DISABLED_SKILL', enabled: false }, f.builder.id);
    f.service.send('team', { body: '选择合适的协作者', recipientIds: [f.reviewer.id] });
    await until(() => f.service.active.size === 0 && prompt);
    assert.match(prompt, /SQL_REVIEW/);
    assert.match(prompt, /not verified abilities or permission grants/);
    assert.doesNotMatch(prompt, /DISABLED_SKILL/);
    assert.equal(f.service.require('members', f.reviewer.id).permission, 'plan');
  } finally { await f.close(); }
});
