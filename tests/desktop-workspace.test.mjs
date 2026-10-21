import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultWorkspace, loadWorkspace, saveWorkspace, trustedSender } from '../desktop/workspace.mjs';
import { temporary, cleanup } from './helpers.mjs';

test('a timestamped desktop build finds its original project while a detached portable app gets its own workspace', () => {
  const root = temporary();
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'server'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'cli-team' }));
    fs.writeFileSync(path.join(project, 'server', 'service.mjs'), '// project marker');
    const executableDir = path.join(project, 'release', '2026-10-08T00-00-00', 'CLI Team-win32-x64');
    const appRoot = path.join(executableDir, 'resources', 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    assert.equal(defaultWorkspace(appRoot, executableDir, true), project);
    assert.equal(defaultWorkspace(project, executableDir, false), project);
    // Keep the portable fixture beyond the ancestor search range of this repository.
    const detachedDir = path.join(root, 'detached', 'one', 'two', 'three', 'four', 'portable');
    fs.mkdirSync(detachedDir, { recursive: true });
    assert.equal(defaultWorkspace(path.join(detachedDir, 'resources', 'app'), detachedDir, true), path.join(detachedDir, 'workspace'));
  } finally { cleanup(root); }
});

test('desktop settings store only the workspace path and invalid saved paths fall back safely', () => {
  const root = temporary();
  try {
    const settingsPath = path.join(root, 'profile', 'settings.json');
    const first = path.join(root, 'first-workspace');
    const second = path.join(root, 'second-workspace');
    const fallback = path.join(root, 'fallback');
    assert.equal(loadWorkspace(settingsPath, fallback), fallback);
    saveWorkspace(settingsPath, first);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { workspace: first });
    assert.equal(loadWorkspace(settingsPath, fallback), first);
    saveWorkspace(settingsPath, second);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { workspace: second });
    assert.equal(loadWorkspace(settingsPath, fallback), second);
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ['settings.json']);
    for (const workspace of ['relative/path', '../other-directory', '', null, 42]) {
      fs.writeFileSync(settingsPath, JSON.stringify({ workspace }));
      assert.equal(loadWorkspace(settingsPath, fallback), fallback);
    }
    fs.writeFileSync(settingsPath, '{invalid settings');
    assert.equal(loadWorkspace(settingsPath, fallback), fallback);
  } finally { cleanup(root); }
});

test('desktop IPC trusts only its own live main frame at the exact backend origin', () => {
  const origin = 'http://127.0.0.1:4317';
  const mainFrame = { url: `${origin}/settings` };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(trustedSender(event, window, origin), true);
  assert.equal(trustedSender({ ...event, sender: { mainFrame } }, window, origin), false);
  assert.equal(trustedSender({ ...event, senderFrame: { url: mainFrame.url } }, window, origin), false);
  assert.equal(trustedSender(event, { ...window, isDestroyed: () => true }, origin), false);
  assert.equal(trustedSender(event, null, origin), false);
  for (const url of ['https://attacker.invalid/', 'http://127.0.0.1:43170/',
    'http://127.0.0.1.attacker.invalid:4317/', 'http://127.0.0.1:4317@attacker.invalid/',
    'https://127.0.0.1:4317/', 'file:///index.html']) {
    mainFrame.url = url;
    assert.equal(trustedSender(event, window, origin), false, url);
  }
});
