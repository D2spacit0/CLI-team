import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TeamService } from '../server/service.mjs';
import { createApp } from '../server/app.mjs';
import { childEnvironment } from '../server/safety.mjs';
import { temporary, cleanup } from './helpers.mjs';

const exec = promisify(execFile);
const businessTools = ['team_business_state', 'team_project_create', 'team_project_message', 'team_project_fact',
  'team_project_material', 'team_content_preview', 'team_content_revision_request'];

async function fixture() {
  const root = temporary();
  const service = new TeamService({ root, proxy: '', detect: () => ({ executable: '', prefixArgs: [] }),
    agentExecutor: async () => { throw new Error('MCP contract tests never start a model'); } });
  const member = (handle, role, permission) => service.saveMember({ name: handle, handle, role, permission,
    provider: 'custom', executable: process.execPath, enabled: true });
  const owner = member('owner', 'builder', 'edit');
  const reviewer = member('reviewer', 'reviewer', 'plan');
  const token = 'fixture-business-controller-token';
  const server = await new Promise(resolve => {
    const instance = createApp(service, { controllerToken: token, desktopToken: 'fixture-business-desktop-token', desktopOnly: true })
      .listen(0, '127.0.0.1', () => resolve(instance));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(root, '.team', 'server.json'), JSON.stringify({ url }));
  fs.writeFileSync(path.join(root, '.team', 'controller.token'), token);
  const env = { ...childEnvironment(''), CLI_TEAM_WORKSPACE: root };
  const client = new Client({ name: 'business-contract-tests', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('tools/mcp.mjs')],
    cwd: process.cwd(), env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); await new Promise(resolve => server.close(resolve)); await service.close(); cleanup(root); throw new Error(`${error.message}: ${stderr}`); }
  const input = key => ({ requestId: key, name: '工具接入验收', objective: '在本地核对固定整稿，不发布',
    ownerId: owner.id, reviewerId: reviewer.id, memberIds: [owner.id, reviewer.id], start: false });
  const invoke = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    return JSON.parse(response.content[0].text);
  };
  const reject = async (name, args, pattern) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, `expected ${name} to reject`);
    if (pattern) assert.match(response.content[0].text, pattern);
  };
  return { root, service, owner, reviewer, client, input, invoke, reject, env,
    async cli(args) { const { stdout } = await exec(process.execPath, [path.resolve('tools/team.mjs'), ...args], { env, windowsHide: true, shell: false }); return JSON.parse(stdout); },
    async close() { await client.close(); await new Promise(resolve => server.close(resolve)); await service.close(); cleanup(root); } };
}

test('MCP advertises controlled business tools alongside legacy tools without publication or shell capabilities', async () => {
  const f = await fixture();
  try {
    const { tools } = await f.client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    for (const name of [...businessTools, 'team_status', 'team_submit_objective', 'team_task', 'team_decide']) assert.ok(names.has(name), name);
    for (const tool of tools.filter(tool => businessTools.includes(tool.name))) {
      for (const forbidden of ['actor', 'adopt', 'executable', 'command', 'approvalDigest', 'confirmed', 'nonce']) assert.equal(tool.inputSchema.properties[forbidden], undefined);
    }
    assert.ok(![...names].some(name => /publish|approval|login|shell/.test(name)));
    await f.reject('team_project_create', { ...f.input('missing-request'), requestId: '' }, /requestId/);
    assert.equal(f.service.projects.list().length, 0);
    const room = await f.invoke('team_room', { name: '保留旧任务入口' });
    assert.equal(room.name, '保留旧任务入口');
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { await f.close(); }
});

test('actual MCP retries share project, message, fact and material receipts and retain controller provenance', async () => {
  const f = await fixture();
  try {
    const creation = f.input('project-once');
    const first = await f.invoke('team_project_create', creation);
    const second = await f.invoke('team_project_create', creation);
    const projectId = first.project.id;
    assert.equal(second.project.id, projectId);
    assert.equal(f.service.projects.list().length, 1);
    await f.reject('team_project_create', { ...creation, objective: 'same key different objective' }, /重复|不同|冲突|请求/);

    const message = { projectId, requestId: 'message-once', body: '核对来源后再整合稿件' };
    const sent = await f.invoke('team_project_message', message);
    assert.equal((await f.invoke('team_project_message', message)).work.id, sent.work.id);
    assert.equal(sent.thread.requesterId, 'controller');

    const fact = { projectId, requestId: 'fact-once', type: 'fact', content: '这条数值需要负责人核对', source: { label: '外部待核验材料' } };
    const claimed = await f.invoke('team_project_fact', fact);
    assert.equal((await f.invoke('team_project_fact', fact)).fact.id, claimed.fact.id);
    assert.equal(claimed.fact.status, 'proposed');
    assert.equal(claimed.fact.evidenceType, 'agent_claim');
    assert.equal(claimed.fact.proposedBy, 'controller');
    assert.equal(claimed.fact.adoptedBy, null);
    assert.equal(f.service.store.list('projectFacts').length, 1);

    const filename = path.join(f.root, 'selected.md');
    fs.writeFileSync(filename, '明确选择的本地资料，不是实拍证据');
    const material = { projectId, requestId: 'material-once', file: filename };
    const imported = await f.invoke('team_project_material', material);
    assert.equal((await f.invoke('team_project_material', material)).material.id, imported.material.id);
    assert.equal(imported.material.submittedBy, 'controller');
    assert.equal(imported.material.evidenceType, 'controller_submission');
    assert.match(imported.material.sha256, /^[a-f0-9]{64}$/);
    fs.writeFileSync(filename, '变化后的资料不能复用旧请求');
    await f.reject('team_project_material', material, /重复|不同|冲突|请求/);
    assert.equal(f.service.store.list('projectMaterials').length, 1);
    assert.equal(f.service.store.get('projectMaterials', imported.material.id).sha256, imported.material.sha256);
    assert.equal(f.service.store.list('runs').length, 0);
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { await f.close(); }
});

test('business state pages stay bounded and project scoped without turning received work into verified work', async () => {
  const f = await fixture();
  try {
    const a = (await f.invoke('team_project_create', f.input('project-a'))).project;
    const b = (await f.invoke('team_project_create', f.input('project-b'))).project;
    for (let index = 0; index < 24; index++) f.service.store.put('workItems', { id: `fixture-work-${index}`, projectId: a.id,
      memberId: f.owner.id, receiverId: f.reviewer.id, checkerId: f.owner.id, kind: 'analysis', status: 'succeeded', handoffStatus: 'received',
      summary: '这是一段较长的成员交付说明。'.repeat(80), generation: 1, outputDigest: 'a'.repeat(64),
      rawCredential: 'MUST_NOT_BE_RETURNED', outputFiles: [{ path: 'PRIVATE_LOCAL_PATH' }] });
    f.service.store.put('workItems', { id: 'other-project-work', projectId: b.id, summary: 'OTHER_PROJECT_CONTENT' });
    const ids = [];
    let offset = 0;
    do {
      const result = await f.invoke('team_business_state', { projectId: a.id, section: 'work', limit: 20, offset });
      assert.equal(result.total, 24);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8000);
      for (const item of result.items) {
        assert.equal(item.status, 'succeeded');
        assert.equal(item.handoffStatus, 'received');
        assert.equal(item.receiverId, f.reviewer.id);
        assert.ok(item.truncatedFields.includes('summary'));
        ids.push(item.id);
      }
      assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_BE_RETURNED|PRIVATE_LOCAL_PATH|OTHER_PROJECT_CONTENT/);
      offset = result.nextOffset;
    } while (offset !== null);
    assert.equal(new Set(ids).size, 24);
    assert.equal(ids.length, 24);
    await f.reject('team_business_state', { projectId: a.id, section: 'work', entityId: 'other-project-work' }, /没有/);
    f.service.store.put('workHandoffs', { id: 'handoff-fixture', projectId: a.id, workItemId: 'fixture-work-0', type: 'received',
      actorId: 'service', recipientId: f.reviewer.id, evidenceType: 'machine', receiptId: 'receipt-fixture' });
    f.service.store.put('workReceipts', { id: 'receipt-fixture', projectId: a.id, workItemId: 'fixture-work-0', resultDigest: 'a'.repeat(64),
      evidenceType: 'machine', checks: ['declared_files'], files: [{ relativePath: 'result.txt', sha256: 'b'.repeat(64), size: 30, path: 'PRIVATE_LOCAL_PATH' }] });
    const handoffs = await f.invoke('team_business_state', { projectId: a.id, section: 'handoffs' });
    assert.equal(handoffs.items[0].type, 'received');
    assert.equal(handoffs.items[0].evidenceType, 'machine');
    const receipts = await f.invoke('team_business_state', { projectId: a.id, section: 'receipts' });
    assert.equal(receipts.items[0].files[0].relativePath, 'result.txt');
    assert.equal(receipts.items[0].files[0].sha256, 'b'.repeat(64));
    assert.equal(receipts.items[0].files[0].path, undefined);
  } finally { await f.close(); }
});

function png() {
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); type.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc(Buffer.concat([type, data])), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(480, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((320 * 3 + 1) * 480, 240); for (let row = 0; row < 480; row++) rows[row * (320 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('fixed draft previews paginate complete Unicode text and reject stale revision requests without exposing approval data', async () => {
  const f = await fixture();
  try {
    const project = (await f.invoke('team_project_create', f.input('fixed-preview'))).project;
    const item = f.service.contentRevisions.createItem(project.id);
    const author = f.service.business.createWork({ projectId: project.id, contentId: item.id, memberId: f.owner.id, kind: 'integrate',
      title: '整合固定稿件', objective: '按照资料写成稿件', output: { type: 'files', files: [{ path: 'note.json', format: 'json' }] } });
    const body = '固定整稿🧩，经验建议需要标明来源。'.repeat(40);
    const tags = Array.from({ length: 10 }, (_, index) => `长标签${'内容'.repeat(30)}${index}`);
    const draft = f.service.contentRevisions.createRevision(item.id, { title: '固定整稿', body, tags,
      sources: [{ kind: 'user', label: '测试夹具资料' }], authorMemberIds: [f.owner.id],
      images: [{ bytes: png(), source: { kind: 'template', label: '测试图片' }, templateVersion: 'fixture-v1', renderCheck: { passed: true } }] });
    const summary = await f.invoke('team_content_preview', { contentId: item.id });
    assert.equal(summary.versionId, draft.id);
    assert.equal(summary.manifestHash, draft.manifestHash);
    assert.equal(summary.excerptTruncated, true);
    assert.equal(summary.tagsTruncated, true);
    assert.equal(summary.tagCount, 10);
    assert.equal(summary.approvalDigest, undefined);
    assert.equal(summary.canApprove, undefined);
    let text = '', textOffset = 0;
    do {
      const result = await f.invoke('team_content_preview', { contentId: item.id, versionId: draft.id, section: 'text', textOffset, textLimit: 97 });
      text += result.text;
      textOffset = result.nextTextOffset;
    } while (textOffset !== null);
    assert.equal(text, body);
    const allTags = await f.invoke('team_content_preview', { contentId: item.id, versionId: draft.id, section: 'tags' });
    assert.deepEqual(allTags.items.map(item => item.tag), tags);
    const images = await f.invoke('team_content_preview', { contentId: item.id, versionId: draft.id, section: 'images' });
    assert.equal(images.items[0].sha256, draft.images[0].sha256);
    assert.equal(images.items[0].index, 0);
    assert.match(images.items[0].previewPath, /\/images\/0$/);
    assert.equal(images.items[0].path, undefined);
    assert.doesNotMatch(JSON.stringify(images), /approvalDigest|desktopSession|controller\.token/);

    const change = { contentId: item.id, versionId: draft.id, requestId: 'return-once', feedback: '补充经验建议的适用条件' };
    const returned = await f.invoke('team_content_revision_request', change);
    const generation = f.service.store.get('workItems', author.id).generation;
    assert.equal((await f.invoke('team_content_revision_request', change)).thread.id, returned.thread.id);
    assert.equal(f.service.store.get('workItems', author.id).generation, generation);
    assert.equal(returned.thread.requesterId, 'controller');
    const newer = f.service.contentRevisions.createRevision(item.id, { title: draft.title, body: `${body}适用条件已补充。`, tags: draft.tags,
      sources: draft.sources, authorMemberIds: draft.authorMemberIds, images: draft.images.map(image => ({ assetId: image.id })) });
    assert.notEqual(newer.id, draft.id);
    await f.reject('team_content_revision_request', { ...change, requestId: 'stale-return' }, /版本|整稿/);
    const old = await f.invoke('team_content_preview', { contentId: item.id, versionId: draft.id, section: 'text' });
    assert.equal(old.text, body);
    assert.equal(f.service.store.list('publicationApprovals').length, 0);
  } finally { await f.close(); }
});

test('CLI business commands reuse the API contracts and reject credential paths before material import', async () => {
  const f = await fixture();
  try {
    const args = ['project-create', '--request-id', 'cli-project', '--name', '命令行项目', '--objective', '仅本地核对',
      '--assignee', f.owner.id, '--reviewer', f.reviewer.id, '--members', `${f.owner.id},${f.reviewer.id}`, '--draft'];
    const project = (await f.cli(args)).project;
    assert.equal((await f.cli(args)).project.id, project.id);
    const messageArgs = ['project-message', project.id, '--request-id', 'cli-message', '--body', '保留字面内容 $(exit) & <稿件>'];
    const message = await f.cli(messageArgs);
    assert.equal((await f.cli(messageArgs)).work.id, message.work.id);
    assert.equal(message.thread.question, '保留字面内容 $(exit) & <稿件>');
    const state = await f.cli(['business-state', project.id, '--section', 'threads']);
    assert.equal(state.items[0].id, message.thread.id);
    const denied = path.join(f.root, 'auth.json');
    fs.writeFileSync(denied, '{"fixture":true}');
    await f.reject('team_project_material', { projectId: project.id, requestId: 'no-credential', file: denied }, /凭据|配置/);
    await assert.rejects(() => f.cli(['project-message', project.id, '--body', '缺少请求 ID']), error => /requestId/.test(error.stderr));
    assert.equal(f.service.store.list('projectMaterials').length, 0);
  } finally { await f.close(); }
});
