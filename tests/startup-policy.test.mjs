import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertStartupAllowed } from '../server/startup-policy.mjs';
import { temporary, cleanup } from './helpers.mjs';

test('security hold blocks startup even if its contents are invalid', () => {
  const root = temporary();
  try {
    fs.mkdirSync(path.join(root, '.team'));
    fs.writeFileSync(path.join(root, '.team', 'security-hold.json'), 'unparsed hold');
    assert.throws(() => assertStartupAllowed(root), /paused for security review/);
  } finally { cleanup(root); }
});

test('no startup hold causes no filesystem or process side effects', () => {
  const root = temporary();
  try {
    assert.doesNotThrow(() => assertStartupAllowed(root));
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { cleanup(root); }
});
