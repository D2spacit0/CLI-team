import type { Member, Run, Task, TaskProgress } from '../types';

export type TaskAction = {
  label: string;
  section?: string;
  tone: 'primary' | 'secondary';
};

export type TaskStateView = {
  tone: 'neutral' | 'running' | 'attention' | 'success' | 'muted';
  eyebrow: string;
  title: string;
  detail: string;
  action: TaskAction;
};

const memberName = (members: readonly Member[], id: string | undefined) =>
  members.find((member) => member.id === id)?.name || id || '未分配成员';

const latest = (runs: readonly Run[]) =>
  [...runs].sort((left, right) =>
    (right.startedAt || right.createdAt).localeCompare(left.startedAt || left.createdAt)
  )[0];

const bounded = (value: string | null | undefined, fallback: string, max = 120) => {
  const text = value?.replace(/\s+/g, ' ').trim() || fallback;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

export function taskStateView(
  task: Task,
  members: readonly Member[],
  progress?: TaskProgress | null,
): TaskStateView {
  const coordination = progress?.taskId === task.id ? progress.coordination : task.coordination;
  const steps = coordination?.steps || [];
  const currentRuns = progress?.taskId === task.id
    ? progress.currentRuns
    : progress?.runs.filter((run) => run.status === 'queued' || run.status === 'running') || [];
  const current = currentRuns.find((run) => run.status === 'running') || currentRuns[0];
  const last = latest(progress?.taskId === task.id ? progress.runs : []);
  const activeStep =
    steps.find((step) => step.status === 'waiting') ||
    steps.find((step) => step.status === 'running') ||
    steps.find((step) => step.status === 'reviewing') ||
    steps.find((step) => step.status === 'failed');
  const completed = steps.filter((step) => step.status === 'succeeded').length;

  if (task.archivedAt) {
    return {
      tone: 'muted', eyebrow: '已归档', title: '任务已从当前工作区收起',
      detail: '历史、文件和记录仍保留，可在归档记录中恢复。',
      action: { label: '查看归档', section: 'plan', tone: 'secondary' },
    };
  }

  if (task.status === 'review') {
    return {
      tone: 'attention', eyebrow: '等待你验收',
      title: `成果已提交${task.reviewerId ? '，评审结果已到齐' : ''}`,
      detail: `${task.gate.status === 'passed' ? '机器检查已通过。' : '请先核对验收条件。'}确认成果与说明后完成验收。`,
      action: { label: '处理验收', section: 'acceptance', tone: 'primary' },
    };
  }

  if (task.status === 'done') {
    return {
      tone: 'success', eyebrow: '任务已完成',
      title: '成果与验收记录已保存',
      detail: bounded(task.summary, '可以继续查看交付文件和完整执行记录。'),
      action: { label: '查看成果', section: 'artifacts', tone: 'secondary' },
    };
  }

  if (task.status === 'cancelled') {
    return {
      tone: 'muted', eyebrow: '任务已取消',
      title: '执行已停止，已有记录仍可查看',
      detail: bounded(task.summary, '如需继续，请新建任务并补充当前约束。'),
      action: { label: '查看记录', section: 'plan', tone: 'secondary' },
    };
  }

  if (task.status === 'blocked') {
    const kind = task.attention?.kind;
    if (kind === 'paused' || task.pausedAt) {
      return {
        tone: 'attention', eyebrow: '已暂停', title: '任务在安全位置停下',
        detail: bounded(task.summary, '成员和执行队列已停止。准备好后可从任务详情继续。'),
        action: { label: '继续任务', section: 'plan', tone: 'primary' },
      };
    }
    if (kind === 'assistance') {
      return {
        tone: 'attention', eyebrow: '需要你的答复',
        title: activeStep ? `${activeStep.title}正在等待信息` : '成员正在等待业务信息',
        detail: bounded(activeStep?.summary || task.summary, '请打开任务详情，回答成员当前的问题。'),
        action: { label: '去答复', section: 'assistance', tone: 'primary' },
      };
    }
    return {
      tone: 'attention', eyebrow: '执行受阻',
      title: activeStep ? `${activeStep.title}未能完成` : '任务暂时无法继续',
      detail: bounded(activeStep?.summary || task.summary || last?.error, '请查看原因并补充信息，然后重新启动。'),
      action: { label: '查看原因', section: 'plan', tone: 'primary' },
    };
  }

  if (current?.status === 'queued') {
    return {
      tone: 'attention', eyebrow: '排队等待启动',
      title: `${memberName(members, current.memberId)}的作业尚未开始`,
      detail: bounded(current.waitReason, '正在等待可用执行名额；无需重复提交。'),
      action: { label: '查看日志', section: 'plan', tone: 'secondary' },
    };
  }

  if (current?.status === 'running') {
    const stepLabel = activeStep ? `${activeStep.title} · ` : '';
    return {
      tone: 'running', eyebrow: '正在执行',
      title: `${memberName(members, current.memberId)}正在处理`,
      detail: `${stepLabel}${bounded(current.summary || activeStep?.summary, '页面会自动刷新，离开当前界面不会终止作业。')}`,
      action: { label: '查看进度', section: 'plan', tone: 'secondary' },
    };
  }

  if (coordination?.phase === 'planning') {
    return {
      tone: 'running', eyebrow: '正在规划',
      title: `${memberName(members, task.assigneeId)}正在拆分工作`,
      detail: steps.length ? '上一轮步骤仍保留，新计划完成后会继续。' : '计划形成后会依次派给成员。',
      action: { label: '查看计划', section: 'plan', tone: 'secondary' },
    };
  }

  if (steps.length) {
    const next = steps.find((step) => step.status !== 'succeeded');
    return {
      tone: next?.status === 'failed' ? 'attention' : 'running',
      eyebrow: `执行计划 ${completed}/${steps.length}`,
      title: next ? `下一步：${next.title}` : '全部步骤已完成',
      detail: next ? `${memberName(members, next.memberId)} · ${
        next.status === 'pending' ? '等待前置步骤' :
        next.status === 'reviewing' ? '主控正在审查' :
        next.status === 'waiting' ? '等待协助答复' : '正在处理'
      }` : '正在整理最终结果与交付检查。',
      action: { label: '查看计划', section: 'plan', tone: 'secondary' },
    };
  }

  if (task.status === 'running') {
    return {
      tone: 'running', eyebrow: '正在执行',
      title: `${memberName(members, task.assigneeId)}正在处理`,
      detail: bounded(last?.summary, '页面会自动刷新；离开当前界面不会终止作业。'),
      action: { label: '查看执行记录', section: 'plan', tone: 'secondary' },
    };
  }

  return {
    tone: 'neutral', eyebrow: '准备启动',
    title: '任务已准备好，尚未开始执行',
    detail: task.executionMode === 'delegated'
      ? '确认成员与验收方式后启动，负责人会拆分步骤。'
      : '确认目标和验收方式后启动，执行人会直接处理。',
    action: { label: '查看并启动', section: 'plan', tone: 'primary' },
  };
}
