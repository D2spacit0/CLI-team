import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('prepared materials reach the worker unchanged and produce an actual combined result', () => {
  const workspace = fs.realpathSync(process.cwd());
  assert.match(workspace, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+[\\/]/i);
  const expected = [['first.txt', 'USABILITY_FIRST_INPUT\n'], ['second.txt', 'USABILITY_SECOND_INPUT\n']];
  const records = expected.map(([name, content]) => {
    const bytes = fs.readFileSync(path.join(workspace, 'inputs', name));
    assert.equal(bytes.toString('utf8'), content);
    return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, 'material-summary.json'), 'utf8')), records);
  assert.equal(fs.readFileSync(path.join(workspace, 'usability-complete.txt'), 'utf8'), 'USABILITY_MATERIALS_READY\n');
});
