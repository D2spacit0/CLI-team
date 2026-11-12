import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublicationEvidence, metricsFromReadback, parseNoteUrl } from '../server/connectors/xiaohongshu.mjs';
import { inspectBrowserArguments, standardBrowserOptions } from '../server/connectors/browser-runtime.mjs';
import { cardSpecSchema } from '../desktop/content-renderer.mjs';

const attempt = { account: { id: 'account-123' }, payload: { title: '完整标题', body: '完整正文', tags: ['知识'],
  images: [{ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }] } };
const evidence = () => ({
  creation: { noteId: '0123456789abcdef01234567', accountId: 'account-123' },
  uploads: [{ index: 0, sha256: 'a'.repeat(64), platformImageId: 'image-a' }, { index: 1, sha256: 'b'.repeat(64), platformImageId: 'image-b' }],
  readback: { noteId: '0123456789abcdef01234567', accountId: 'account-123', title: '完整标题', body: '完整正文',
    tags: ['知识'], imageIds: ['image-a', 'image-b'], source: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567', collectedAt: '2026-11-11T00:00:00.000Z' },
});

test('publication evidence needs the exact creation identity, account, upload mappings and readback order', () => {
  assert.equal(verifyPublicationEvidence(attempt, evidence()).matched, true);
  const mutations = [value => { delete value.creation; }, value => { value.creation.accountId = 'other-account'; },
    value => { delete value.uploads; }, value => { value.uploads[1].sha256 = 'c'.repeat(64); },
    value => { value.readback.imageIds.reverse(); }, value => { value.readback.body = '相似正文'; },
    value => { value.readback.tags = ['别的话题']; }, value => { value.readback.noteId = 'fedcba9876543210fedcba98'; },
    value => { delete value.readback.source; }];
  for (const mutate of mutations) { const value = evidence(); mutate(value); assert.equal(verifyPublicationEvidence(attempt, value).matched, false); }
  for (const value of [undefined, { success: true, status: 200 }, { url: evidence().readback.source }, { candidates: [evidence().readback] }]) {
    assert.equal(verifyPublicationEvidence(attempt, value).matched, false);
  }
});

test('missing platform metrics remain unavailable and never become measured zeros', () => {
  const values = metricsFromReadback('note-id', 'platform-readback', { likes: 0, comments: 7, collects: '12' });
  assert.equal(values.find(item => item.name === 'likes').value, 0);
  assert.equal(values.find(item => item.name === 'likes').status, 'available');
  assert.equal(values.find(item => item.name === 'collects').value, null);
  assert.equal(values.find(item => item.name === 'impressions').status, 'unavailable');
  assert.equal(values.find(item => item.name === 'clickThroughRate').visibility, 'creator_analytics');
});

test('browser pipe and sandbox are enforced without accepting model-supplied flags', () => {
  assert.equal(standardBrowserOptions({ executablePath: process.execPath }, { visible: false }).chromiumSandbox, true);
  assert.equal(inspectBrowserArguments(['chrome', '--remote-debugging-pipe']).transport, 'pipe');
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--remote-debugging-port=9222']) {
    assert.throws(() => inspectBrowserArguments(['chrome', '--remote-debugging-pipe', flag]), /安全启动/);
  }
  assert.throws(() => inspectBrowserArguments(['chrome']), /安全启动/);
  assert.throws(() => parseNoteUrl('http://127.0.0.1/internal'), /详情链接/);
  assert.throws(() => parseNoteUrl('https://www.xiaohongshu.com.attacker.invalid/explore/0123456789abcdef01234567'), /详情链接/);
  assert.equal(parseNoteUrl(evidence().readback.source).noteId, '0123456789abcdef01234567');
});

test('template requests accept inert text and reject executable template and oversized data', () => {
  const text = '<img src=x onerror=alert(1)>';
  assert.equal(cardSpecSchema.parse({ template: 'cover', title: text }).title, text);
  assert.throws(() => cardSpecSchema.parse({ template: 'cover', title: '标题', html: '<script>1</script>' }));
  assert.throws(() => cardSpecSchema.parse({ template: 'list', title: '标题', items: [] }));
  assert.throws(() => cardSpecSchema.parse({ template: 'cover', title: '长'.repeat(73) }));
});
