import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('independent acceptance: exact file content and no extra artifacts', () => {
  const filename = path.join(process.cwd(), 'health.txt');
  assert.equal(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').trim(), 'CLI_TEAM_OK');
  assert.deepEqual(fs.readdirSync(process.cwd()), ['health.txt']);
});
