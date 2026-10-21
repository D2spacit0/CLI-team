import fs from 'node:fs';
import path from 'node:path';

export function assertStartupAllowed(root, dataDir = path.join(root, '.team')) {
  const holds = [path.join(root, '.team', 'security-hold.json'), path.join(dataDir, 'security-hold.json')];
  if (holds.some((hold) => fs.existsSync(hold))) {
    throw new Error('CLI Team startup is paused for security review. See SECURITY-REVIEW.md. No server or agents were started.');
  }
}
