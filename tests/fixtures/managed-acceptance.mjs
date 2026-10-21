import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('managed module is integrated and ready', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(process.cwd(), name), 'utf8'));
  assert.deepEqual(read('module.json'), { feature: 'goal-intake', ready: true });
  assert.deepEqual(read('delivery.json'), { ready: true, module: read('module.json') });
});
