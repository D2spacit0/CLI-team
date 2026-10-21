import { createHash } from 'node:crypto';
import { stepOutputUnchanged } from './step-output.mjs';
import { inspectMaterials } from './materials.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only explicit step inputs, member runtime, and recorded dependencies can justify
// reuse. A successful CLI exit alone never creates a reusable checkpoint.
export function stepFingerprint(service, task, step) {
  const member = service.require('members', step.memberId);
  return hash({ taskId: task.id, planId: task.coordination?.planId, objective: task.objective, requirements: task.requirements,
    verification: task.verification, materials: (task.materials || []).map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
    sourceContext: task.sourceContext,
    step: { key: step.key, title: step.title, objective: step.objective, memberId: step.memberId,
      dependsOn: step.dependsOn, output: step.output },
    member: { id: member.id, role: member.role, provider: member.provider, model: member.model, executable: member.executable,
      prefixArgs: member.prefixArgs, customArgs: member.customArgs, permission: member.permission, inputMode: member.inputMode },
    dependencies: step.dependsOn.map((key) => ({ key, runId: task.coordination.steps.find((item) => item.key === key)?.runId })),
  });
}

export function checkpointForStep(service, task, step, run, outputCheck) {
  if (outputCheck.status !== 'passed') return null;
  return { runId: run.id, fingerprint: stepFingerprint(service, task, step), checkedAt: outputCheck.checkedAt };
}

export function reusableStepKeys(service, task) {
  const steps = task.coordination?.steps || [];
  const valid = new Set();
  const visited = new Set();
  // Plans have at most six steps. Visiting dependencies first also invalidates all
  // downstream checkpoints when one input or its producing attempt has changed.
  const visit = (step) => {
    if (visited.has(step.key)) return valid.has(step.key);
    visited.add(step.key);
    if (step.status !== 'succeeded' || !step.checkpoint || step.checkpoint.runId !== step.runId) return false;
    if (task.managed) {
      const review = step.ownerReview;
      const reviewRun = review?.runId && service.store.get('runs', review.runId);
      if (!review || review.verdict !== 'approve' || review.sourceRunId !== step.runId || review.ownerId !== task.assigneeId ||
          !reviewRun || reviewRun.taskId !== task.id || reviewRun.planId !== task.coordination.planId ||
          reviewRun.stage !== 'step_review' || reviewRun.memberId !== task.assigneeId ||
          reviewRun.sourceRunId !== step.runId || reviewRun.status !== 'succeeded' || reviewRun.report?.verdict !== 'approve') return false;
    }
    if (!step.dependsOn.every((key) => { const dependency = steps.find((item) => item.key === key); return dependency && visit(dependency); })) return false;
    const run = service.store.get('runs', step.runId);
    if (!run || run.taskId !== task.id || run.planId !== task.coordination.planId || run.stepKey !== step.key ||
        run.stage !== 'delegate' || run.memberId !== step.memberId || run.status !== 'succeeded') return false;
    try {
      if (stepFingerprint(service, task, step) !== step.checkpoint.fingerprint ||
          !stepOutputUnchanged(task, step, run, step.outputCheck)) return false;
    } catch { return false; }
    valid.add(step.key);
    return true;
  };
  steps.forEach(visit);
  return valid;
}

export function delegationResume(service, task, { checkOutputs = true, reusableKeys = null } = {}) {
  const steps = task.coordination?.steps || [];
  const unavailable = (reason) => ({ available: false, reusableSteps: 0, totalSteps: steps.length, reason });
  if (task.executionMode !== 'delegated' || !task.coordination?.planId || !steps.length) return unavailable('暂无可恢复的步骤计划');
  if (!steps.every((step) => step.output)) return unavailable('旧计划含未配置交付检查的步骤，继续时由负责人重新规划');
  if (task.pendingFeedback) return unavailable('分工或要求已调整，继续时由负责人重新规划');
  if (task.coordination.requiresReplan || ['failed', 'stale'].includes(task.gate?.status)) {
    return unavailable('整体验收或评审需要修正，继续时由负责人重新规划');
  }
  const phase = task.coordination.resumePhase || task.coordination.phase;
  if (!['working', 'checking', 'assisting', 'synthesizing'].includes(phase)) return unavailable('当前阶段需要负责人重新规划');
  const helps = service.assistance.list(task.id).filter((help) => help.planId === task.coordination.planId);
  const unanswered = helps.some((help) => help.status === 'blocked' && !help.interrupted);
  if (unanswered) return unavailable('请先保存协作问题的答复，或填写反馈后重新规划');
  if (!checkOutputs) return unavailable('成员或验收仍在执行，停止后才会重新核对可保留的交付');
  if (inspectMaterials(task).some((material) => material.integrity !== 'verified')) {
    return unavailable('输入材料已变化，不能使用旧步骤检查点');
  }
  const reusableSteps = (reusableKeys || reusableStepKeys(service, task)).size;
  return { available: true, reusableSteps, totalSteps: steps.length,
    reason: `${helps.some((help) => help.interrupted && help.status === 'blocked') ? '继续处理已中断的协作求助；' : ''}继续时保留 ${reusableSteps}/${steps.length} 个交付检查仍有效的步骤，其余步骤重新执行` };
}

export function resumedSteps(service, task, reason = '') {
  const reusable = reusableStepKeys(service, task);
  return task.coordination.steps.map((step) => reusable.has(step.key) ? step : {
    ...step, status: 'pending', previousRunId: step.runId || step.previousRunId || null, runId: null, checkpoint: null,
    previousOutputCheck: step.outputCheck || step.previousOutputCheck || null, outputCheck: null,
    ...(task.managed ? { previousOwnerReview: step.ownerReview || step.previousOwnerReview || null,
      ownerReview: null, reviewRunId: null } : {}),
    resumeFeedback: [step.resumeFeedback, reason, step.status === 'succeeded' ? '原交付检查或依赖已失效，请重新核查并完成本步骤。' : '']
      .filter(Boolean).join('\n').slice(-8000),
  });
}
