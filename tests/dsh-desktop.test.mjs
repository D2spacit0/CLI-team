import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPackage } from '@electron/asar';
import { discoverDshDesktop, dshDesktopCommand, dshDesktopInfo, dshInstalledVersion } from '../server/dsh-installation.mjs';
import { inspectCliEntry, resolveDshDesktopMigration } from '../server/adapters.mjs';
import { runtimeFingerprint } from '../server/cli-runtime.mjs';
import { prepareDshRuntime } from '../server/dsh-runner.mjs';
import { TeamService } from '../server/service.mjs';
import { temporary, cleanup } from './helpers.mjs';

const windows = { skip: process.platform !== 'win32' };
function write(filename, text) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); }
async function installation(root, version = '0.2.0-rc.2') {
  const install = path.join(root, 'installed DSH');
  const tree = path.join(root, 'archive-source');
  write(path.join(install, 'DeepSeek Harness.exe'), 'MZ fixture, never executed');
  write(path.join(tree, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  write(path.join(tree, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), '// official carrier fixture');
  fs.mkdirSync(path.join(install, 'resources'), { recursive: true });
  await createPackage(tree, path.join(install, 'resources/app.asar'));
  return { provider: 'dsh', ...dshDesktopCommand(install), id: 'dsh-fixture', model: '', permission: 'plan' };
}

test('desktop detection reads the installed ASAR without extracting or launching a GUI', windows, async () => {
  const root = temporary();
  try {
    const member = await installation(root);
    const entry = inspectCliEntry(member);
    assert.equal(entry.detected, true, entry.error);
    assert.equal(entry.entryPoint, member.prefixArgs[1]);
    assert.equal(fs.existsSync(entry.entryPoint), false, 'ordinary Node cannot stat ASAR paths');
    assert.equal(dshInstalledVersion(member), '0.2.0-rc.2');
    assert.deepEqual(discoverDshDesktop([path.dirname(member.executable)]), { executable: member.executable, prefixArgs: member.prefixArgs });
    for (const prefixArgs of [[], [member.prefixArgs[1]], ['--expose-internals', path.join(root, 'wrong.js')]]) {
      assert.equal(inspectCliEntry({ ...member, prefixArgs }).detected, false);
    }
    assert.equal(inspectCliEntry({ ...member, customArgs: ['--yolo'] }).detected, false);
  } finally { cleanup(root); }
});

test('an in-place desktop update invalidates its cached version and connection fingerprint', windows, async () => {
  const root = temporary();
  try {
    const member = await installation(root);
    const before = runtimeFingerprint(member, root);
    await installation(root, '0.2.0-rc.20');
    assert.equal(dshDesktopInfo(member).version, '0.2.0-rc.20');
    assert.notEqual(runtimeFingerprint(member, root), before);
  } finally { cleanup(root); }
});

test('live Cordis config is read only inside the child and never copied to generated patches', windows, async () => {
  const root = temporary();
  try {
    const member = await installation(root);
    const profile = path.join(root, 'official/profiles/desktop/cordis.patch.yml');
    const content = JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'local', model: 'qwen', reasoningEffort: 'off' } },
      { id: 'llm-pi-ai', config: { providers: { local: { apiKeyEnv: 'OFFICIAL_KEY',
        baseURL: 'https://private-host.invalid/?token=sentinel-url-secret',
        headers: { Authorization: 'sentinel-header-secret' }, models: [{ id: 'qwen' }] } } } },
      { insert: [{ id: 'desktop-only', name: './never-execute.mjs' }] },
    ]);
    write(profile, content);
    const priorEnv = process.env.ELECTRON_RUN_AS_NODE;
    const runtime = prepareDshRuntime({ dataDir: path.join(root, 'data'), sourceHome: path.join(root, 'official'), analysisOnly: true }, member);
    const text = fs.readFileSync(runtime.patchFile, 'utf8');
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, priorEnv);
    assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(runtime.env.DSH_PERMISSION_MODE, 'read-only');
    assert.equal(runtime.nodeArgs[0], '--import');
    for (const secret of ['sentinel-url-secret', 'sentinel-header-secret', 'private-host.invalid', 'OFFICIAL_KEY', 'never-execute']) {
      assert.ok(!JSON.stringify(runtime).includes(secret), secret);
      assert.ok(!text.includes(secret), secret);
    }
    const patch = JSON.parse(text);
    assert.equal(patch.find((p) => p.id === 'settings').disabled, true);
    assert.equal(patch.find((p) => p.id === 'config-editor').disabled, true);
    assert.ok(patch.find((p) => p.id === 'llm-pi-ai').config.__jsExpr);
    const child = path.join(root, 'validate-preload.mjs');
    write(child, `import assert from 'node:assert/strict';
const data = globalThis[Symbol.for('cli-team.dsh.models')];
assert.equal(data['llm-pi-ai'].providers.local.headers.Authorization, 'sentinel-header-secret');
assert.equal(data['llm-pi-ai'].providers.local.apiKeyEnv, 'OFFICIAL_KEY');
assert.equal(data['agent-default-model'].reasoningEffort, 'off');
assert.equal(data['desktop-only'], undefined);
assert.equal(process.env.CLI_TEAM_DSH_MODEL_SOURCES, undefined);
console.log('child-config-ok');`);
    const env = { ...runtime.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(process.execPath, [...runtime.nodeArgs, child], { env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'child-config-ok');
    assert.equal(fs.readFileSync(profile, 'utf8'), content);
    const resumed = prepareDshRuntime({ dataDir: path.join(root, 'data'), sourceHome: path.join(root, 'official'),
      analysisOnly: true, conversationId: 'native-session' }, member);
    const resumePatch = fs.readFileSync(resumed.patchFile, 'utf8');
    assert.ok(resumePatch.includes('dsh-acp-resume-bridge.mjs'));
    assert.equal(resumed.recovery.sessionId, 'native-session');
    for (const secret of ['sentinel-url-secret', 'sentinel-header-secret', 'private-host.invalid', 'OFFICIAL_KEY', 'never-execute']) {
      assert.ok(!JSON.stringify(resumed).includes(secret), secret);
      assert.ok(!resumePatch.includes(secret), secret);
    }
  } finally { cleanup(root); }
});

function legacy(root) {
  const home = path.join(root, 'official');
  const entry = path.join(home, 'profiles/node_modules/@deepseek-ai/dsh/lib/bin.js');
  write(entry, '// legacy CLI');
  write(path.join(path.dirname(entry), '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }));
  return { home, member: { id: 'legacy-dsh', provider: 'dsh', executable: process.execPath, prefixArgs: [entry],
    name: '原成员', handle: 'original-dsh', role: 'builder', model: 'local/qwen', permission: 'plan', enabled: true,
    skills: '原技能', customArgs: [], inputMode: 'stdin', createdAt: '2026-10-01T00:00:00Z' } };
}

test('migration is limited to the old auto-discovered entry and preserves custom installations', windows, async () => {
  const root = temporary();
  try {
    const desktop = await installation(root);
    const { home, member } = legacy(root);
    const detect = () => ({ executable: desktop.executable, prefixArgs: desktop.prefixArgs });
    assert.deepEqual(resolveDshDesktopMigration(member, home, detect), detect());
    for (const variant of [{ ...member, provider: 'custom' }, { ...member, prefixArgs: [...member.prefixArgs, '--custom-flag'] },
      { ...member, prefixArgs: [path.join(root, 'custom/bin.js')] }, { ...member, executable: 'other.exe' }]) {
      assert.equal(resolveDshDesktopMigration(variant, home, detect), null);
    }
    assert.equal(resolveDshDesktopMigration(member, home, () => ({ executable: '', prefixArgs: [] })), null);
  } finally { cleanup(root); }
});

test('service migration retains members and sessions and defers reserved members', windows, async () => {
  const root = temporary();
  const previousHome = process.env.DSH_HOME;
  let service;
  try {
    const desktop = await installation(root);
    const { home, member } = legacy(root);
    process.env.DSH_HOME = home;
    const detect = (provider) => provider === 'dsh' ? { executable: desktop.executable, prefixArgs: desktop.prefixArgs } : { executable: '', prefixArgs: [] };
    service = new TeamService({ root, detect, proxy: '' });
    service.store.put('members', member);
    const conversation = { id: 'team:legacy-dsh', conversationId: 'keep-native-session' };
    service.store.put('conversations', conversation);
    service.store.put('runs', { id: 'pending', memberId: member.id, status: 'queued' });
    service.discover();
    assert.equal(service.require('members', member.id).executable, member.executable);
    await assert.rejects(service.probeMember(member.id), /正在参与/);
    service.store.remove('runs', 'pending');
    service.discover();
    const migrated = service.require('members', member.id);
    assert.equal(migrated.executable, desktop.executable);
    for (const key of ['name', 'handle', 'role', 'model', 'permission', 'enabled', 'skills', 'customArgs', 'createdAt']) assert.deepEqual(migrated[key], member[key]);
    assert.deepEqual(service.store.list('conversations'), [conversation]);
    assert.equal(service.store.list('runs').length, 0);
    assert.deepEqual(service.repairMemberEntry(migrated), migrated);
    service.store.put('members', { ...member, id: 'on-restart', handle: 'on-restart' });
    await service.close();
    service = new TeamService({ root, detect, proxy: '' });
    assert.equal(service.require('members', 'on-restart').executable, desktop.executable);
  } finally {
    if (service) await service.close();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    cleanup(root);
  }
});
