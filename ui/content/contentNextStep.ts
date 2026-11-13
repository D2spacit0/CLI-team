import type { BusinessProject } from '../types';

export type ContentNextAction = 'approve' | 'refresh' | 'latest' | 'account' | 'team' | 'runtime' | 'evidence' | 'conversation' | 'reconcile' | 'schedule';
export interface ContentNextStep { title: string; detail: string; action: ContentNextAction; actionLabel: string }
export interface ContentNextStepInput {
  canApprove: boolean; submitting: boolean; uncertain: boolean; published: boolean;
  stale: boolean; loading: boolean; previewError: boolean; workspacePaused: boolean;
  projectStatus: BusinessProject['status']; accountReady: boolean; hasReviewer: boolean;
  imagesReady: boolean; hasDesktopApproval: boolean; approvalQueued: boolean;
  gates: { machinePassed: boolean; reviewPassed: boolean; machineFailed: boolean; reviewRejected: boolean; stale: boolean; eligible: boolean } | null;
  reviewerName?: string; reason?: string; scopeBlockedReason?: string;
}

export function contentNextStep(input: ContentNextStepInput): ContentNextStep {
  if (input.submitting) return { title: '已开始提交，等待平台结果', detail: '本次批准版本已冻结，继续查看提交与核实进展。', action: 'refresh', actionLabel: '刷新发布进展' };
  if (input.uncertain) return { title: '等待核实这次发布', detail: '可能已经提交，由程序回读账号、正文与配图关联。', action: 'reconcile', actionLabel: '查看核实入口' };
  if (input.published) return { title: '发布结果已核实', detail: '可返回项目查看后续成果与反馈。', action: 'conversation', actionLabel: '返回项目' };
  if (input.stale) return { title: '请查看团队的最新整稿', detail: '当前是历史版本，最新版本需要重新核对。', action: 'latest', actionLabel: '查看最新整稿' };
  if (input.previewError) return { title: '先重新读取整稿状态', detail: '本次读取失败，重新取得当前检查和发布条件后才能继续。', action: 'refresh', actionLabel: '重试读取状态' };
  if (input.loading) return { title: '正在核对本版发布条件', detail: '读取当前版本、账号、检查和审稿记录。', action: 'refresh', actionLabel: '读取中' };
  if (input.projectStatus === 'archived') return { title: '项目已归档', detail: '稿件和原记录保留供查看。', action: 'conversation', actionLabel: '返回项目' };
  if (input.workspacePaused) return { title: '工作区已暂停新增工作', detail: '到运行设置查看暂停原因，再决定是否恢复工作区。', action: 'runtime', actionLabel: '查看运行设置' };
  if (input.projectStatus !== 'active') return { title: input.projectStatus === 'paused' ? '项目已暂停新增工作' : '项目有待处理条件', detail: '返回项目查看原因，再决定下一步安排。', action: 'conversation', actionLabel: '查看项目进展' };
  if (!input.accountReady) return { title: '先核对这个项目的发布账号', detail: '登录、检测连接后，明确绑定到当前项目；账号变化会使旧审查失效。', action: 'account', actionLabel: '核对项目账号' };
  if (!input.hasReviewer) return { title: '先指定独立审稿成员', detail: '项目需要一位与作者不同的审稿成员。', action: 'team', actionLabel: '配置审稿成员' };
  if (input.gates?.stale) return { title: '本版需要重新检查与审稿', detail: input.reason || '账号、来源或稿件范围已变化，原审查不再适用。', action: 'evidence', actionLabel: '查看失效原因' };
  if (!input.gates?.machinePassed) return { title: input.gates?.machineFailed ? '先处理程序检查问题' : '等待程序完成本版检查', detail: input.reason || (input.gates?.machineFailed ? '请根据检查问题退回团队修改，再收取新版本。' : '程序需要核对固定稿件、实际配图和采用的来源。'), action: 'evidence', actionLabel: '查看程序检查' };
  if (!input.gates.reviewPassed) return { title: input.gates.reviewRejected ? '等待团队按审稿意见修改' : `等待${input.reviewerName || '独立审稿成员'}审稿`, detail: input.reason || (input.gates.reviewRejected ? '审稿意见要求修改，处理后再审查新版本。' : '程序检查已通过，仍需本版独立审稿的有效结论。'), action: 'evidence', actionLabel: '查看审稿意见' };
  if (!input.imagesReady) return { title: '请确认完整配图', detail: '配图尚未全部显示，重新加载后再核对发布顺序和内容。', action: 'refresh', actionLabel: '重新加载整稿' };
  if (input.scopeBlockedReason) return { title: '请调整本版发布范围', detail: input.scopeBlockedReason, action: 'schedule', actionLabel: '设置新的发布范围' };
  if (!input.hasDesktopApproval) return { title: '到桌面工作台完成最终确认', detail: '本页不能授予发布批准，请在桌面工作台打开这一稿件。', action: 'conversation', actionLabel: '返回项目' };
  if (input.approvalQueued) return { title: '已批准，等待执行与核实', detail: '继续查看发布进展；开始提交前可以撤销批准。', action: 'refresh', actionLabel: '刷新发布进展' };
  if (input.canApprove && input.gates.eligible) return { title: '请确认本版整稿与发布范围', detail: '检查与独立审稿已通过。批准后会打开桌面最终确认。', action: 'approve', actionLabel: '批准本版发布' };
  return { title: '等待核对剩余发布条件', detail: input.reason || '现有检查和审稿不等于发布授权，请查看当前条件。', action: 'evidence', actionLabel: '查看发布条件' };
}
