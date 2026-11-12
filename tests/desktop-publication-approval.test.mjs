import test from 'node:test';
import assert from 'node:assert/strict';
import { requestNativePublicationApproval } from '../desktop/publication-approval.mjs';

function fixture() {
  const frame = { url: 'http://127.0.0.1:43210/' };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const event = { sender: window.webContents, senderFrame: frame };
  const calls = [];
  const backend = { state: {}, child: { connected: true }, request: async (type, input) => {
    calls.push({ type, input });
    if (type === 'publication:begin') return { result: { nonce: 'main-backend-only-nonce', summary: { title: '权威标题', account: { id: 'account-123', name: '发布账号' },
      imageCount: 2, timeWindow: { kind: 'immediate' }, versionId: 'version-fixed' } } };
    return { result: { approvalId: 'approved-fixed-version' } };
  } };
  const context = { origin: 'http://127.0.0.1:43210', generation: 1, workspace: 'D:/fixed-workspace', backendState: backend.state };
  const options = { event, window, backend, getContext: () => context, contentId: 'content-1', versionId: 'version-fixed', expectedDigest: 'a'.repeat(64),
    showMessageBox: async () => ({ response: 0 }) };
  return { event, options, backend, context, calls };
}

test('native publishing ceremony rejects secondary frames and caller confirmation before requesting a challenge', async () => {
  const f = fixture();
  f.event.senderFrame = { url: 'http://127.0.0.1:43210/' };
  await assert.rejects(requestNativePublicationApproval({ ...f.options, confirmed: true, actor: 'user' }), /其他页面/);
  assert.equal(f.calls.length, 0);
});

test('cancelling the native confirmation never creates an approval or exposes nonce to renderer', async () => {
  const f = fixture();
  let shown;
  const receipt = await requestNativePublicationApproval({ ...f.options, showMessageBox: async (_window, options) => { shown = options; return { response: 0 }; } });
  assert.deepEqual(receipt, { cancelled: true });
  assert.match(shown.message, /权威标题/);
  assert.match(shown.detail, /account-123/);
  assert.equal(f.calls.some(call => call.type === 'publication:confirm'), false);
  assert.equal(JSON.stringify(receipt).includes('nonce'), false);
  assert.equal(JSON.stringify(shown).includes('main-backend-only-nonce'), false);
});

test('native confirmation only commits the authoritative version while navigation and backend changes invalidate it', async () => {
  const f = fixture();
  const receipt = await requestNativePublicationApproval({ ...f.options, showMessageBox: async () => ({ response: 1 }) });
  assert.deepEqual(receipt, { approvalId: 'approved-fixed-version' });
  assert.equal(f.calls.find(call => call.type === 'publication:confirm').input.nonce, 'main-backend-only-nonce');
  for (const mutate of [fixture => { fixture.context.generation++; }, fixture => { fixture.backend.state = {}; }, fixture => { fixture.context.workspace = 'D:/other-workspace'; }]) {
    const changed = fixture();
    await assert.rejects(requestNativePublicationApproval({ ...changed.options, showMessageBox: async () => { mutate(changed); return { response: 1 }; } }), /改变/);
    assert.equal(changed.calls.some(call => call.type === 'publication:confirm'), false);
  }
});
