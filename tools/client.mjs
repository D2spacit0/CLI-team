import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.CLI_TEAM_WORKSPACE
  ? path.resolve(process.env.CLI_TEAM_WORKSPACE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function connection() {
  let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(path.join(root, '.team', 'server.json'), 'utf8')); }
  catch { throw new Error('CLI Team 桌面程序尚未启动；若已切换目录，请设置 CLI_TEAM_WORKSPACE。'); }
  const url = new URL(descriptor.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('拒绝连接非本机服务');
  const token = fs.readFileSync(path.join(root, '.team', 'controller.token'), 'utf8').trim();
  return { url: url.origin, token };
}
export async function request(route, body, { method, timeout = 70000 } = {}) {
  const { url, token } = connection();
  const response = await fetch(`${url}${route}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function compact(value, maxBytes = 8000) {
  if (value?.taskId && Array.isArray(value.currentRuns)) {
    const assistance = (Array.isArray(value.assistance) ? value.assistance : []).filter((help) =>
      ['blocked', 'pending', 'consulting'].includes(help.status) &&
      (!value.coordination?.planId || help.planId === value.coordination.planId));
    return { taskId: value.taskId, active: value.active, canPause: value.canPause, canReassign: value.canReassign,
      ...(value.managed ? { managed: true, delivery: compactDelivery(value.delivery) } : {}),
      remainingRepairs: value.remainingRepairs, reviewerExcludedIds: value.reviewerExcludedIds,
      totalRuns: value.totalRuns, omittedRuns: value.omittedRuns,
      currentRuns: value.currentRuns.map(({ id, memberId, stage, status, waitReason }) => ({ id, memberId, stage, status, waitReason })),
      coordination: value.coordination ? { phase: value.coordination.phase, round: value.coordination.round,
        steps: value.coordination.steps.map(({ key, title, memberId, status, dependsOn, runId, outputCheck, checkpointValid, checkpointReason, reviewRunId, ownerReview }) =>
          ({ key, title, memberId, status, dependsOn, runId,
            ...(value.managed ? { reviewRunId: reviewRunId || null, ownerReview: ownerReview ? {
              runId: ownerReview.runId, sourceRunId: ownerReview.sourceRunId, verdict: ownerReview.verdict,
              summary: String(ownerReview.summary || '').slice(0, 300) } : null } : {}),
            checkpointValid: typeof checkpointValid === 'boolean' ? checkpointValid : null,
            checkpointReason: checkpointReason ? String(checkpointReason).slice(0, 240) : null,
            outputCheck: outputCheck ? { status: outputCheck.status, type: outputCheck.type,
              ...(typeof outputCheck.checkedAt === 'string' ? { checkedAt: outputCheck.checkedAt } : {}),
              summary: String(outputCheck.summary || '').slice(0, 180) } : null })) } : null,
      assistance: assistance.slice(-6).map(({ id: helpId, status, stepKey, question, interrupted }) =>
        ({ helpId, status, stepKey, question: String(question || '').slice(0, 240),
          ...(String(question || '').length > 240 ? { questionTruncated: true } : {}),
          ...(interrupted ? { interrupted: true } : {}) })),
      ...(assistance.length > 6 ? { omittedAssistance: assistance.length - 6 } : {}),
      resume: value.resume ? { available: value.resume.available, reusableSteps: value.resume.reusableSteps,
        totalSteps: value.resume.totalSteps, reason: String(value.resume.reason || '').slice(0, 300) } : null,
      recentProblems: value.runs.filter((run) => ['failed', 'blocked', 'cancelled', 'interrupted'].includes(run.status))
        .slice(0, 3).map(({ id, memberId, stage, status, summary, riskFlags }) => ({ id, memberId, stage, status, summary: String(summary || '').slice(0, 500), riskFlags })) };
  }
  if (value?.id?.startsWith('task-') && value.workspace && value.objective) {
    return { id: value.id, title: value.title, status: value.status, workspace: value.workspace,
      ...(value.managed ? { managed: true, delivery: compactDelivery(value.delivery) } : {}),
      executionMode: value.executionMode || 'direct', assigneeId: value.assigneeId,
      participantIds: value.participantIds || [],
      coordination: value.coordination ? { phase: value.coordination.phase, round: value.coordination.round,
        steps: value.coordination.steps.map(({ key, title, memberId, status, dependsOn, runId }) =>
          ({ key, title, memberId, status, dependsOn, runId })) } : null,
      roomId: value.roomId, gate: value.gate, reviewVerdict: value.reviewVerdict || null,
      materialCount: value.materials?.length || 0, sourceSessionId: value.sourceSessionId || null,
      summary: String(value.summary || '').slice(0, 1000) };
  }
  if (value?.taskId && Array.isArray(value.materials)) {
    const materials = [];
    const ordered = [...value.materials].sort((a, b) =>
      Number(b.integrity !== 'verified') - Number(a.integrity !== 'verified'));
    for (const item of ordered) {
      if (Buffer.byteLength(JSON.stringify([...materials, item])) > maxBytes - 700) break;
      materials.push(item);
    }
    return { taskId: value.taskId, locked: value.locked, count: value.materials.length,
      verified: value.materials.filter((item) => item.integrity === 'verified').length,
      totalBytes: value.materials.reduce((total, item) => total + item.size, 0),
      limits: value.limits, materials, omitted: value.materials.length - materials.length };
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) return value;
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      if (Buffer.byteLength(JSON.stringify([...items, item])) > maxBytes - 200) break;
      items.push(item);
    }
    return { items, omitted: value.length - items.length, needsEvidence: true };
  }
  return { id: value.id || value.taskId || null, state: value.state || value.status || null,
    summary: String(value.summary || value.error || '').slice(0, 1000),
    gate: value.gate || null, riskFlags: value.riskFlags || [],
    needsEvidence: true, reason: '输出超过主控回包上限，完整结果保留在工作台' };
}

function compactDelivery(delivery) {
  if (!delivery) return null;
  return { status: delivery.status, runId: delivery.runId, ownerId: delivery.ownerId,
    summary: String(delivery.summary || '').slice(0, 1000), limitation: delivery.limitation,
    gateStatus: delivery.gateStatus, evidenceId: delivery.evidenceId, artifactRevision: delivery.artifactRevision,
    artifactCount: delivery.artifacts?.length || 0 };
}
