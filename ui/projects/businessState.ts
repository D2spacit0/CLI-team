import type {
  BusinessSnapshot, ContentItem, ContentRevision, PublicationAttempt,
  BusinessWorkItem, MetricValue, MetricsSnapshot, ContentEligibility, ContentCheck, ContentReview,
} from '../types';

export type BusinessTone = 'neutral' | 'working' | 'ready' | 'attention' | 'danger';
export interface BusinessStateLabel { label: string; tone: BusinessTone; detail?: string }
export type PublicationGroup = 'awaiting' | 'queued' | 'sending' | 'unknown' | 'published' | 'preparing';

export const emptyBusinessState = (): BusinessSnapshot => ({
  projects: [], projectFacts: [], projectMaterials: [], productionCycles: [], workItems: [], contentItems: [],
  contentRevisions: [], contentEligibilities: [], contentChecks: [], reviews: [],
  collaborationThreads: [], actions: [], workHandoffs: [], workReceipts: [], skillCatalog: [],
  publications: [], approvals: [], attempts: [],
  metrics: [], connection: null,
});

export function normalizeBusinessState(value: BusinessSnapshot): BusinessSnapshot {
  const empty = emptyBusinessState();
  return Object.fromEntries(Object.entries(empty).map(([key, fallback]) => {
    const actual = value?.[key as keyof BusinessSnapshot];
    return [key, Array.isArray(fallback) ? (Array.isArray(actual) ? actual : fallback) : actual || null];
  })) as unknown as BusinessSnapshot;
}

export const newest = <T extends { createdAt: string }>(items: T[]): T | null =>
  [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;

export const currentContentVersion = (item: ContentItem): string | null =>
  item.currentRevisionId || item.currentDraftVersionId || null;

export function contentRevision(state: BusinessSnapshot, item: ContentItem): ContentRevision | null {
  const id = currentContentVersion(item);
  return state.contentRevisions.find((revision) => revision.id === id && revision.contentId === item.id) || null;
}

export const latestAttempt = (state: BusinessSnapshot, contentId: string): PublicationAttempt | null =>
  newest(state.attempts.filter((attempt) => attempt.contentId === contentId));

export function unresolvedSubmission(attempt: PublicationAttempt | null | undefined): boolean {
  return Boolean(attempt?.submissionMayHaveOccurred && attempt.status !== 'published');
}

export function itemEligibility(state: BusinessSnapshot, item: ContentItem): ContentEligibility | null {
  return state.contentEligibilities.find((entry) => (entry.contentId || entry.id) === item.id) || null;
}

export function publicationGroup(state: BusinessSnapshot, item: ContentItem): PublicationGroup {
  const attempt = latestAttempt(state, item.id);
  if (attempt?.status === 'published') return 'published';
  if (attempt?.status === 'sending') return 'sending';
  if (unresolvedSubmission(attempt) || ['verifying', 'unknown'].includes(attempt?.status || '')) return 'unknown';
  const approval = newest(state.approvals.filter((entry) => entry.contentId === item.id));
  if (approval && approval.versionId === currentContentVersion(item) && ['approved', 'queued'].includes(approval.status)
    && itemEligibility(state, item)?.status !== 'invalid') return 'queued';
  if (item.status === 'published') return 'published';
  const eligibility = itemEligibility(state, item);
  if (currentContentVersion(item) && (eligibility?.status === 'eligible'
    || ['awaiting_approval', 'review', 'ready', 'approved', 'expired', 'revoked'].includes(item.status))) return 'awaiting';
  return 'preparing';
}

export function contentState(state: BusinessSnapshot, item: ContentItem): BusinessStateLabel {
  const group = publicationGroup(state, item);
  const attempt = latestAttempt(state, item.id);
  if (group === 'unknown') return { label: '结果待核实', tone: 'attention', detail: attempt?.verificationBlocked || attempt?.reason || '可能已提交，等待平台回读核对' };
  if (group === 'sending') return { label: '发布中', tone: 'working', detail: '已经开始提交，正在保存与核对发布证据' };
  if (group === 'published') return { label: '已核实发布', tone: 'ready' };
  if (group === 'queued') return { label: '已批准待执行', tone: 'working' };
  if (group === 'awaiting') return { label: '待批准整稿', tone: 'attention' };
  const labels: Record<string, BusinessStateLabel> = {
    failed: { label: '制作需处理', tone: 'danger' },
    blocked: { label: '等待补充条件', tone: 'attention' },
    revising: { label: '团队修改中', tone: 'working' },
    changes_requested: { label: '团队修改中', tone: 'working' },
    abandoned: { label: '已放弃', tone: 'neutral' },
    cancelled: { label: '已取消', tone: 'neutral' },
  };
  if (labels[item.status]) return labels[item.status];
  const eligibility = itemEligibility(state, item);
  if (eligibility?.status === 'invalid') return { label: '待重新审查', tone: 'attention', detail: eligibility.reason };
  return { label: currentContentVersion(item) ? '团队审查中' : '内容制作中', tone: 'working' };
}

export function workState(item: BusinessWorkItem): BusinessStateLabel {
  const handoffs: Record<string, BusinessStateLabel> = {
    assigned: { label: '已派发，待接手', tone: 'neutral' },
    accepted: { label: '已接手', tone: 'working' },
    received: { label: '成果已收取，待核对', tone: 'attention' },
    verified: { label: '本项已验收', tone: 'ready' },
    returned: { label: '已退回修改', tone: 'attention' },
    blocked: { label: '交接受阻', tone: 'attention' },
    cancelled: { label: '已取消', tone: 'neutral' },
  };
  const names: Record<string, BusinessStateLabel> = {
    proposed: { label: '待负责人采纳', tone: 'neutral' },
    pending: { label: '待安排', tone: 'neutral' },
    ready: { label: '待执行', tone: 'neutral' },
    queued: { label: '等待执行名额', tone: 'neutral' },
    running: { label: '正在执行', tone: 'working' },
    waiting: { label: '等待前序成果', tone: 'neutral' },
    waiting_dependencies: { label: '等待前序成果', tone: 'neutral' },
    waiting_answer: { label: '等待同伴答复', tone: 'attention' },
    waiting_tool: { label: '等待工具结果', tone: 'working' },
    checking: { label: '检查成果', tone: 'working' },
    reviewing: { label: '业务审查中', tone: 'working' },
    completed: { label: '运行已结束，待验收', tone: 'attention' },
    succeeded: { label: '运行已结束，待验收', tone: 'attention' },
    done: { label: '运行已结束，待验收', tone: 'attention' },
    interrupted: { label: '运行已中断', tone: 'attention' },
    blocked: { label: '需要处理', tone: 'attention' },
    failed: { label: '执行失败', tone: 'danger' },
    cancelled: { label: '已取消', tone: 'neutral' },
    superseded: { label: '已被新工作替代', tone: 'neutral' },
  };
  const handoff = item.handoffStatus ? handoffs[item.handoffStatus] : null;
  const failed = ['failed', 'blocked', 'interrupted'].includes(item.status);
  return { ...((failed ? names[item.status] : handoff) || names[item.status] || { label: '状态待确认', tone: 'attention' }), detail: item.waitReason || item.error || item.summary };
}

export function revisionChanges(before: ContentRevision | null, after: ContentRevision): string[] {
  if (!before) return ['首次形成完整稿件'];
  const changes: string[] = [];
  if (before.title !== after.title) changes.push('标题已修改');
  if (before.body !== after.body) changes.push('正文已修改');
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) changes.push('话题已调整');
  if (JSON.stringify(before.images.map((image) => image.sha256)) !== JSON.stringify(after.images.map((image) => image.sha256))) {
    changes.push(before.images.length === after.images.length ? '图片内容或顺序已调整' : `图片从 ${before.images.length} 张调整为 ${after.images.length} 张`);
  }
  if (before.visibility !== after.visibility) changes.push('可见范围已调整');
  if (JSON.stringify(before.schedule) !== JSON.stringify(after.schedule)) changes.push('发布时间已调整');
  if (JSON.stringify(before.inputRefs) !== JSON.stringify(after.inputRefs)) changes.push('采用的资料版本已更新');
  return changes.length ? changes : ['内容未改变，已重新收取版本'];
}

export function contentGateSummary(revision: ContentRevision, eligibility: ContentEligibility | null | undefined,
  checks: ContentCheck[], reviews: ContentReview[]) {
  const stale = Boolean(eligibility && (eligibility.status === 'invalid' || eligibility.versionId !== revision.id));
  const matchingChecks = checks.filter((check) => check.versionId === revision.id && check.manifestHash === revision.manifestHash && !check.invalidatedAt);
  const selectedCheckIds = eligibility?.checkIds?.length ? eligibility.checkIds : eligibility?.checkId ? [eligibility.checkId] : [];
  const activeChecks = selectedCheckIds.length ? matchingChecks.filter((check) => selectedCheckIds.includes(check.id)) : matchingChecks;
  const matchingReviews = reviews.filter((review) => review.versionId === revision.id && review.manifestHash === revision.manifestHash
    && review.status === 'current' && !review.invalidatedAt && !revision.authorMemberIds.includes(review.memberId));
  const selectedReviewIds = eligibility?.reviewId ? [eligibility.reviewId] : eligibility?.reviewIds || [];
  const activeReviews = selectedReviewIds.length ? matchingReviews.filter((review) => selectedReviewIds.includes(review.id)) : matchingReviews;
  const machinePassed = !stale && activeChecks.length > 0 && activeChecks.every((check) => check.passed && check.status === 'passed');
  const reviewPassed = !stale && activeReviews.length > 0 && activeReviews.every((review) => review.verdict === 'approve');
  return {
    machine: { label: stale ? '检查已失效' : machinePassed ? '文件与字段检查通过' : activeChecks.length ? '检查未通过' : '尚未完成程序检查', tone: machinePassed ? 'ready' : stale || activeChecks.length ? 'attention' : 'neutral' } as BusinessStateLabel,
    review: { label: stale ? '审稿已失效' : reviewPassed ? '独立审稿通过' : activeReviews.length ? '有待处理的审稿意见' : '尚未完成独立审稿', tone: reviewPassed ? 'ready' : stale || activeReviews.length ? 'attention' : 'neutral' } as BusinessStateLabel,
    machinePassed, reviewPassed,
  };
}

const metricNames: Record<string, string> = {
  likes: '点赞', likedCount: '点赞', collections: '收藏', favorites: '收藏', collects: '收藏',
  comments: '评论', shares: '分享', impressions: '曝光', views: '浏览', clicks: '点击', ctr: '点击率', clickThroughRate: '点击率',
};

export function metricValues(snapshot: MetricsSnapshot): MetricValue[] {
  if (Array.isArray(snapshot.metrics)) return snapshot.metrics;
  if (snapshot.metrics && typeof snapshot.metrics === 'object') return Object.entries(snapshot.metrics).map(([name, value]) =>
    value && typeof value === 'object' ? { ...value, name } : { name, value, source: snapshot.source });
  if (snapshot.name) return [{ name: snapshot.name, value: snapshot.value ?? null, unavailableReason: snapshot.unavailableReason, source: snapshot.source }];
  return [];
}

export function metricDisplay(metric: MetricValue): { label: string; value: string; missing: boolean; reason: string } {
  const missing = metric.status === 'unavailable' || typeof metric.value !== 'number' || !Number.isFinite(metric.value);
  return {
    label: metric.label || metricNames[metric.name] || metric.name,
    value: missing ? '未取得' : metric.value!.toLocaleString('zh-CN'),
    missing, reason: metric.unavailableReason || metric.reason || (missing ? '平台尚未提供这项数据' : ''),
  };
}

export function safeSourceUrl(value?: string): string | null {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export const businessTime = (value?: string | null, timeZone?: string): string => {
  if (!value || Number.isNaN(Date.parse(value))) return '尚无记录';
  return new Date(value).toLocaleString('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
