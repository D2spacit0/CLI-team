import { inspectWindowsSupervision } from './windows-process-supervisor.mjs';

// Process absence is checked against the OS. Lease age is never an exit proof.
// No command lines, environments or client credentials are queried.
export function inspectProcessExit(processState) {
  const pid = processState?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { confirmed: false, reason: '未取得可核对的进程身份' };
  if (processState.supervision?.kind === 'windows_job') return inspectWindowsSupervision(processState);
  // A process enumeration cannot reconstruct grandchildren after an intermediate
  // process exits. Historical PID-only records therefore remain quarantined.
  if (processState.supervision?.kind !== 'posix_process_group' || process.platform === 'win32') {
    return { confirmed: false, reason: '缺少进程树监督证明，根PID消失不能证明后代进程已经退出' };
  }
  try { process.kill(pid, 0); return { confirmed: false, reason: '原进程仍存在或PID已被复用' }; }
  catch (error) { if (error.code !== 'ESRCH') return { confirmed: false, reason: '无法核对原进程' }; }
  try { process.kill(-pid, 0); return { confirmed: false, reason: '原进程组仍有活动进程' }; }
  catch (error) { if (error.code !== 'ESRCH') return { confirmed: false, reason: '无法核对原进程组' }; }
  return { confirmed: true, method: 'os_process_and_group_absent', pid, checkedAt: new Date().toISOString() };
}
