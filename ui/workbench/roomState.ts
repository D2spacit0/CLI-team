import type { Member, Message, Task } from '../types';
import { memberUnavailableReason } from '../memberAvailability.ts';

export const taskStatusLabels: Record<Task['status'], string> = {
  backlog: '待启动', running: '执行中', review: '待验收', done: '已完成', blocked: '需要处理', cancelled: '已取消',
};
export const runStatusLabels: Record<string, string> = {
  queued: '排队中', running: '运行中', succeeded: '执行完成', failed: '执行失败',
  blocked: '已阻塞', cancelled: '已取消', interrupted: '已中断',
};
export const gateLabels: Record<Task['gate']['status'], string> = {
  not_configured: '未配置机器检查', pending: '机器检查待完成', passed: '机器检查通过', failed: '机器检查失败', stale: '机器检查已失效',
};
export const stageLabels: Record<string, string> = {
  plan: '负责人规划', delegate: '成员执行', implement: '执行与汇总', coordinate: '处理求助',
  consult: '同伴协助', review: '独立评审', verify: '机器检查', verification: '机器检查', chat: '聊天咨询',
  step_review: '主控审查子任务', final_review: '主控终审与交付', message: '任务咨询',
  independent: '独立分析', challenge: '交叉质疑', synthesis: '汇总讨论',
};

export function parseRecipientIds(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? [...new Set(parsed)] : [];
  } catch { return []; }
}

// Keep routing identical to TeamService.send, including mentions of disabled
// members (which must block sending rather than silently change the audience).
export function messageAudience(body: string, selected: readonly string[], members: readonly Member[]) {
  const handles = [...new Set([...body.matchAll(/@([a-z][a-z0-9-]{1,39})\b/g)].map((match) => match[1]))];
  const mentioned = members.filter((member) => handles.includes(member.handle) && member.provider !== 'controller');
  const ids = [...new Set([...selected, ...mentioned.map((member) => member.id)])];
  const recipients = ids.map((id) => members.find((member) => member.id === id));
  const problems = recipients.flatMap((member, index) => {
    const reason = memberUnavailableReason(member);
    return reason ? [(member?.name || ids[index]) + '：' + reason] : [];
  });
  if (ids.length > 4) problems.unshift('单条消息最多发送给 4 名成员，包含正文中的 @ 提及。');
  return {
    ids, recipients, problems, commander: handles.includes('commander'),
    unknown: handles.filter((handle) => handle !== 'commander' && !members.some((member) => member.handle === handle)),
  };
}

export function mergeRoomMessages(roomId: string, ...sources: readonly Message[][]): Message[] {
  const byId = new Map<string, Message>();
  for (const messages of sources) for (const message of messages) {
    if (message.roomId === roomId) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function acceptanceIssue(task: Task, note: string, acknowledged: boolean): string {
  if (task.archivedAt || task.status !== 'review') return '任务尚未进入待验收状态。';
  if (['failed', 'stale', 'pending'].includes(task.gate.status)) return '机器检查尚未通过或已失效，请先完成检查。';
  if (task.reviewerId && task.reviewVerdict !== 'approve') return '独立评审尚未通过。';
  if (task.gate.status !== 'passed' && !acknowledged) return '请明确确认本任务缺少自动化验收证据。';
  if (!note.trim()) return '请填写验收备注。';
  if (note.trim().length > 2000) return '验收备注最多 2000 字。';
  return '';
}
