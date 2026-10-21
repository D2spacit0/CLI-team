import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('DSH creates exactly the requested UTF-8 JSON artifact', () => {
  assert.deepEqual(fs.readdirSync(process.cwd()), ['result.json']);
  const result = JSON.parse(fs.readFileSync('result.json', 'utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(result, { project: 'CLI Team', answer: 323, items: ['甲', '乙', '丙'] });
});
