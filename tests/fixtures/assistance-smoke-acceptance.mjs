import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('independent assistance smoke gate checks the confirmed field and final deliverables', () => {
  const workspace = fs.realpathSync(process.cwd());
  assert.match(workspace, /[\\/]work[\\/]desktop-smoke[\\/]run-[^\\/]+[\\/]/i);
  const readJson = (name) => JSON.parse(fs.readFileSync(path.join(workspace, name), 'utf8'));
  assert.equal(readJson('prepared.json').field, 'stable_record_id');
  assert.deepEqual(readJson('finished.json'), { field: 'stable_record_id', ready: true });
  assert.equal(fs.readFileSync(path.join(workspace, 'integration.txt'), 'utf8').trim(), 'ASSISTANCE_SMOKE_INTEGRATED');
  assert.deepEqual(fs.readdirSync(workspace).sort(), ['finished.json', 'integration.txt', 'prepared.json']);
});
