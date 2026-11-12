import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A dispatcher belongs to a workspace, not to its HTTP port. This is also used
// by embedded/direct TeamService instances that do not go through runtime.mjs.
export function acquireWorkspaceOwner(dataDir) {
  const filename = path.join(dataDir, 'scheduler.lock');
  const recoveryPath = `${filename}.recovery`;
  const ownerId = randomUUID();
  const claim = () => {
    const fd = fs.openSync(filename, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let guard;
    try { guard = fs.openSync(recoveryPath, 'wx', 0o600); }
    catch { throw new Error('工作区调度归属正在核对，请稍后重试'); }
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch { throw new Error('无法核实工作区调度锁，未启动第二个调度器'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('工作区调度锁无效，不能自动覆盖');
      let gone = false;
      try { process.kill(previous.pid, 0); }
      catch (cause) { if (cause.code === 'ESRCH') gone = true; }
      if (!gone) throw new Error('此工作区已有活动调度器，请先停止原实例');
      fs.unlinkSync(filename);
      claim();
    } finally { fs.closeSync(guard); fs.unlinkSync(recoveryPath); }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      if (JSON.parse(fs.readFileSync(filename, 'utf8')).ownerId === ownerId) fs.unlinkSync(filename);
    } catch { /* An unreadable/replaced lock is never removed. */ }
  };
  process.once('exit', release);
  return { ownerId, release };
}
