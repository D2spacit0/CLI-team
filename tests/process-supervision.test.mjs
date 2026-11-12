import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runProcess } from '../server/runner.mjs';
import { inspectProcessExit } from '../server/process-state.mjs';
import { temporary, cleanup, until } from './helpers.mjs';

const absent = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};
function detachedTree(root) {
  const leafPid = path.join(root, 'leaf.pid'), release = path.join(root, 'release');
  const leaf = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(leafPid)},String(process.pid));` +
    `setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},25);`;
  const intermediate = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],` +
    `{detached:true,stdio:'ignore'}).unref();`;
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],` +
    `{detached:true,stdio:'ignore'}).unref();`;
  return { leafPid, release, code };
}

test('Windows supervision waits for orphaned grandchildren and its receipt survives a fresh host process',
  { skip: process.platform !== 'win32' }, async () => {
    const root = temporary(), tree = detachedTree(root);
    let state, result, settled = false;
    const execution = runProcess({ executable: process.execPath, args: ['-e', tree.code], cwd: root, proxy: '',
      timeoutMs: 10000, logFile: path.join(root, 'supervision.log'), onProcess: value => { state = value; } })
      .then(value => { settled = true; result = value; return value; });
    try {
      await until(() => state?.pid && fs.existsSync(tree.leafPid), 8000);
      const launch = JSON.parse(fs.readFileSync(state.supervision.startPath, 'utf8'));
      const leafPid = Number(fs.readFileSync(tree.leafPid, 'utf8'));
      await until(() => absent(launch.rootPid));
      assert.equal(absent(leafPid), false);
      assert.equal(settled, false, 'root exit cannot release the host process slot');
      assert.equal(inspectProcessExit(state).confirmed, false);
      fs.writeFileSync(tree.release, 'release');
      await execution;
      assert.equal(result.exitCode, 0);
      assert.equal(result.processExitConfirmed, true);
      assert.equal(result.processExitEvidence.method, 'windows_job_empty');
      assert.equal(result.processExitEvidence.receipt.activeProcesses, 0);
      assert.equal(absent(leafPid), true);
      // Read the durable proof through a genuinely different Node process.
      const moduleUrl = new URL('../server/process-state.mjs', import.meta.url).href;
      const reader = spawn(process.execPath, ['--input-type=module', '-e',
        `import {inspectProcessExit} from ${JSON.stringify(moduleUrl)};let s='';for await(const c of process.stdin)s+=c;` +
        `console.log(JSON.stringify(inspectProcessExit(JSON.parse(s))));`],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      reader.stdout.setEncoding('utf8'); reader.stdout.on('data', chunk => { output += chunk; });
      reader.stdin.end(JSON.stringify(state));
      const code = await new Promise((resolve, reject) => { reader.on('error', reject); reader.on('close', resolve); });
      assert.equal(code, 0);
      assert.equal(JSON.parse(output).confirmed, true);
      const receipt = JSON.parse(fs.readFileSync(state.supervision.receiptPath, 'utf8'));
      fs.writeFileSync(state.supervision.receiptPath, JSON.stringify({ ...receipt, id: 'another-invocation' }));
      assert.equal(inspectProcessExit(state).confirmed, false, 'a receipt from another attempt cannot release a lease');
    } finally {
      fs.writeFileSync(tree.release, 'release');
      await execution;
      cleanup(root);
    }
  });

test('Windows supervisor death kills its job but absence without a durable receipt remains unconfirmed',
  { skip: process.platform !== 'win32' }, async () => {
    const root = temporary(), tree = detachedTree(root);
    let state;
    const execution = runProcess({ executable: process.execPath, args: ['-e', tree.code], cwd: root, proxy: '',
      timeoutMs: 10000, logFile: path.join(root, 'killed-supervisor.log'), onProcess: value => { state = value; } });
    try {
      await until(() => state?.pid && fs.existsSync(tree.leafPid), 8000);
      const leafPid = Number(fs.readFileSync(tree.leafPid, 'utf8'));
      process.kill(state.pid, 'SIGKILL');
      const result = await execution;
      await until(() => absent(leafPid));
      assert.equal(result.processExitConfirmed, false);
      assert.equal(inspectProcessExit(state).confirmed, false);
      assert.equal(fs.existsSync(state.supervision.receiptPath), false);
    } finally {
      fs.writeFileSync(tree.release, 'release');
      await execution;
      cleanup(root);
    }
  });

test('Windows supervised invocation preserves argument boundaries without interpreting shell characters',
  { skip: process.platform !== 'win32' }, async () => {
    const root = temporary();
    const args = ['', '中文 空格', 'quote"inside', 'trailing\\', '\\"mixed', '& echo never', '$(never)', '%PATH%'];
    try {
      const result = await runProcess({ executable: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
        cwd: root, proxy: '', timeoutMs: 3000, logFile: path.join(root, 'args.log') });
      assert.equal(result.exitCode, 0);
      assert.equal(result.processExitConfirmed, true);
      assert.deepEqual(JSON.parse(result.output), args);
    } finally { cleanup(root); }
  });
