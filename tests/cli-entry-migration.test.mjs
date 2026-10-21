import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { TeamService } from '../server/service.mjs';
import { createApp } from '../server/app.mjs';
import { inspectCliEntry } from '../server/adapters.mjs';
import { temporary, cleanup } from './helpers.mjs';

const windows = { skip: process.platform !== 'win32' };
const noDiscovery = () => ({ executable: '', prefixArgs: [] });

function npmInstallation(root) {
  const npm = path.join(root, 'npm');
  const entry = path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(entry), '..', 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }));
  fs.writeFileSync(entry, `import fs from 'node:fs';
if (process.argv.at(-1) !== '--version') process.exit(7);
fs.writeFileSync(new URL('./probe-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
console.log('codex-cli 1.2.3');
`);
  for (const suffix of ['', '.cmd', '.ps1']) fs.writeFileSync(path.join(npm, `codex${suffix}`), '#!/bin/sh\nexit 9\n');
  return { shim: path.join(npm, 'codex'), entry };
}

function legacyMember(shim, extra = {}) {
  return { id: 'legacy-codex', name: 'Codex CLI', handle: 'legacy-codex', provider: 'codex', role: 'builder',
    executable: shim, prefixArgs: ['--profile', 'kept-profile'], customArgs: [], inputMode: 'stdin',
    skills: '保留成员技能', enabled: true, permission: 'plan', model: '', detected: true,
    createdAt: '2026-09-17T00:00:00.000Z', ...extra };
}

test('upgrading an existing workspace repairs its saved npm entry and keeps its model, permissions and sessions', windows, async () => {
  const root = temporary();
  let service;
  try {
    const { shim, entry } = npmInstallation(root);
    service = new TeamService({ root, proxy: '', detect: noDiscovery });
    const legacy = legacyMember(shim);
    const conversation = { id: `team:${legacy.id}`, conversationId: 'original-native-session' };
    service.store.put('members', legacy);
    service.store.put('conversations', conversation);
    const settings = service.settings();
    await service.close(); service = null;
    service = new TeamService({ root, proxy: '', detect: noDiscovery });
    const upgraded = service.members().find((member) => member.id === legacy.id);
    assert.equal(upgraded.detected, true);
    assert.equal(upgraded.status, 'ready');
    assert.equal(upgraded.executable, process.execPath);
    assert.deepEqual(upgraded.prefixArgs, [entry, ...legacy.prefixArgs]);
    for (const field of ['model', 'permission', 'enabled', 'role', 'name', 'handle', 'skills', 'createdAt', 'customArgs', 'inputMode']) {
      assert.deepEqual(upgraded[field], legacy[field], field);
    }
    assert.deepEqual(service.settings(), settings);
    assert.deepEqual(service.store.list('conversations'), [conversation]);
    assert.equal(service.store.list('runs').length, 0);
    assert.equal(upgraded.runtime.status, 'unchecked');
    const checked = await service.probeMember(legacy.id);
    assert.equal(checked.runtime.status, 'available', checked.runtime.error);
    assert.equal(checked.runtime.version, '1.2.3');
    assert.equal(checked.runtime.checks.launch, 'passed');
    assert.equal(checked.runtime.checks.authentication, 'not_checked');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'probe-args.json'), 'utf8')), [...legacy.prefixArgs, '--version']);
    const saved = service.store.get('members', legacy.id);
    await service.close(); service = null;
    service = new TeamService({ root, proxy: '', detect: noDiscovery });
    assert.deepEqual(service.store.get('members', legacy.id), saved, 'subsequent starts do not rewrite the entry');
  } finally { if (service) await service.close(); cleanup(root); }
});

test('the existing check-connection HTTP action repairs an old saved entry before probing it', windows, async () => {
  const root = temporary();
  const { shim, entry } = npmInstallation(root);
  const service = new TeamService({ root, proxy: '', detect: noDiscovery });
  const member = legacyMember(shim, { model: 'user-selected-model', enabled: false });
  service.store.put('members', member);
  const app = createApp(service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/members/${member.id}/probe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 200);
    const checked = await response.json();
    assert.equal(checked.runtime.status, 'available', checked.runtime.error);
    assert.deepEqual(checked.prefixArgs, [entry, ...member.prefixArgs]);
    assert.equal(checked.model, 'user-selected-model');
    assert.equal(checked.enabled, false);
    assert.equal(checked.status, 'disabled');
    assert.equal(checked.runtime.checks.protocol, 'not_checked');
    assert.equal(service.store.list('runs').length, 0);
    assert.equal(service.store.list('conversations').length, 0);
  } finally {
    app.closeStreams();
    await new Promise((resolve) => server.close(resolve));
    await service.close(); cleanup(root);
  }
});

test('saving supported npm wrappers resolves the same installation and preserves prefix arguments', windows, async () => {
  const root = temporary();
  const { shim, entry } = npmInstallation(root);
  const service = new TeamService({ root, proxy: '', detect: noDiscovery });
  try {
    for (const [index, suffix] of ['', '.cmd', '.ps1'].entries()) {
      const member = service.saveMember(legacyMember(shim + suffix, { handle: `saved-${index}` }));
      assert.equal(member.detected, true, suffix || 'extensionless shim');
      assert.equal(member.executable, process.execPath);
      assert.deepEqual(member.prefixArgs, [entry, '--profile', 'kept-profile']);
      assert.equal(member.model, '');
      assert.equal(member.runtime.status, 'unchecked');
    }
    assert.throws(() => service.saveMember(legacyMember(shim, { handle: 'unsafe', prefixArgs: ['--yolo'] })), /绕过审批/);
  } finally { await service.close(); cleanup(root); }
});

test('discovery repairs the selected npm installation before considering another client on PATH', windows, async () => {
  const root = temporary();
  const { shim, entry } = npmInstallation(root);
  const service = new TeamService({ root, proxy: '', detect: noDiscovery });
  try {
    const member = legacyMember(shim);
    service.store.put('members', member);
    service.detect = () => ({ executable: process.execPath, prefixArgs: [path.resolve('tests/fixtures/fake-dsh.mjs')] });
    service.discover();
    const repaired = service.store.get('members', member.id);
    assert.deepEqual(repaired.prefixArgs, [entry, ...member.prefixArgs]);
    assert.equal(repaired.model, '');
  } finally { await service.close(); cleanup(root); }
});

test('startup preserves custom paths and incomplete installations without claiming they are missing files', windows, async () => {
  const root = temporary();
  let service;
  try {
    const { shim, entry } = npmInstallation(root);
    const manual = path.join(root, 'manual', 'codex');
    fs.mkdirSync(path.dirname(manual)); fs.writeFileSync(manual, '#!/bin/sh\n');
    service = new TeamService({ root, proxy: '', detect: noDiscovery });
    const members = [legacyMember(shim, { id: 'custom-client', provider: 'custom' }),
      legacyMember(manual, { id: 'incomplete-client' }),
      legacyMember(process.execPath, { id: 'valid-client', prefixArgs: [entry] }),
      legacyMember(shim, { id: 'different-provider', provider: 'claude' })];
    for (const member of members) service.store.put('members', member);
    await service.close(); service = null;
    service = new TeamService({ root, proxy: '', detect: noDiscovery });
    for (const member of members) assert.deepEqual(service.store.get('members', member.id), member);
    const inspected = inspectCliEntry(members[1]);
    assert.equal(inspected.detected, false);
    assert.match(inspected.error, /文件存在.*Windows/);
    assert.equal(service.store.list('runs').length, 0);
  } finally { if (service) await service.close(); cleanup(root); }
});

test('queued members cannot have their entry changed by a connection check, discovery, or a name edit', windows, async () => {
  const root = temporary();
  const { shim } = npmInstallation(root);
  const service = new TeamService({ root, proxy: '', detect: noDiscovery });
  try {
    const member = legacyMember(shim);
    service.store.put('members', member);
    service.store.put('runs', { id: 'queued-run', memberId: member.id, status: 'queued' });
    await assert.rejects(service.probeMember(member.id), /正在参与/);
    service.discover();
    service.saveMember({ name: '新名字' }, member.id);
    const saved = service.store.get('members', member.id);
    assert.equal(saved.name, '新名字');
    assert.equal(saved.executable, shim);
    assert.deepEqual(saved.prefixArgs, member.prefixArgs);
  } finally { await service.close(); cleanup(root); }
});
