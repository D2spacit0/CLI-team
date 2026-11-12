import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BusinessStore } from './business-store.mjs';
import { XiaohongshuConnector, normalizePublicationPayload, verifyPublicationEvidence, parseNoteUrl } from './connectors/xiaohongshu.mjs';

const approvalInput = z.object({ contentId: z.string().min(1).max(180), versionId: z.string().min(1).max(180),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const terminalApproval = new Set(['revoked', 'expired', 'blocked', 'published']);
const ambiguous = attempt => Boolean(attempt.submissionMayHaveOccurred && attempt.status !== 'published');
const error = (message, status = 409) => Object.assign(new Error(message), { status });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function scheduleFor(revision) {
  const schedule = revision.schedule || { kind: 'immediate' };
  if (schedule.kind !== 'scheduled') return { kind: 'immediate', startsAt: null, endsAt: null, display: '批准后10分钟内' };
  const date = new Date(schedule.startsAt);
  if (!Number.isFinite(date.getTime())) throw error('发布时间无效。', 400);
  const startsAt = date.toISOString(), endsAt = new Date(date.getTime() + 600000).toISOString();
  return { kind: 'scheduled', startsAt, endsAt, display: `${startsAt} 至 ${endsAt}` };
}

/** Publication authority is intentionally absent from HTTP/CLI and from model tools. */
export class PublicationService {
  constructor({ store, root, connector, resolveSnapshot, inspectRevision, wake = () => {}, now = () => Date.now(), onEvent } = {}) {
    this.store = store;
    this.root = path.resolve(root);
    this.queue = new BusinessStore(store);
    this.connector = connector || new XiaohongshuConnector({ root: this.root });
    this.resolveSnapshot = resolveSnapshot;
    this.inspectRevision = inspectRevision;
    this.wake = wake;
    this.now = now;
    this.onEvent = onEvent;
    this.instanceId = randomUUID();
    this.sessions = new Set();
    this.ticking = null;
    this.closed = false;
  }
  stamp() { return new Date(this.now()).toISOString(); }
  changed(type, value) {
    const event = this.store.event(type, value);
    this.store.afterCommit(() => { this.onEvent?.(event); this.wake(); });
  }
  connection() { return this.connector.status(); }
  async probe() {
    const connection = await this.connector.probe();
    this.store.put('businessConnections', { id: 'xiaohongshu', ...connection, updatedAt: this.stamp() });
    this.changed('business.connection', { status: connection.status, account: connection.account, version: connection.version });
    return connection;
  }
  async openLogin() { return this.connector.openLogin(); }

  preview(contentId, versionId) {
    if (typeof this.resolveSnapshot !== 'function') throw error('图文版本服务尚未就绪。', 503);
    const bundle = this.resolveSnapshot(contentId, versionId);
    if (!bundle?.revision || !bundle?.project || !bundle?.item) throw error('稿件版本不存在。', 404);
    const { revision, project, eligibility } = bundle;
    const payload = normalizePublicationPayload(revision);
    const connection = this.connection();
    const account = project.account || null;
    const timeWindow = scheduleFor(revision);
    const checks = bundle.checks || [];
    const reviews = bundle.reviews || [];
    const approvals = this.store.list('publicationApprovals').filter(item => item.contentId === contentId);
    const attempts = this.store.list('publicationAttempts').filter(item => item.contentId === contentId);
    const approval = approvals.at(-1) || null;
    const attempt = attempts.at(-1) || null;
    const fingerprint = {
      projectId: project.id, contentId, versionId: revision.id, manifestHash: revision.manifestHash || revision.digest,
      payload: { ...payload, images: payload.images.map(({ path: _path, ...image }) => image) },
      account: account ? { id: account.id, platform: account.platform, connectorVersion: account.connectorVersion } : null,
      connectorVersion: connection.version || this.connector.version,
      timeWindow: { kind: timeWindow.kind, startsAt: timeWindow.startsAt, endsAt: timeWindow.endsAt },
      eligibility: eligibility ? { id: eligibility.id, revision: eligibility.revision, versionId: eligibility.versionId,
        status: eligibility.status, inputRefs: eligibility.inputRefs, checkIds: eligibility.checkIds, reviewIds: eligibility.reviewIds } : null,
      checks: checks.map(item => ({ id: item.id, versionId: item.versionId, manifestHash: item.manifestHash, status: item.status, passed: item.passed, invalidatedAt: item.invalidatedAt })),
      reviews: reviews.map(item => ({ id: item.id, versionId: item.versionId, manifestHash: item.manifestHash, status: item.status,
        verdict: item.verdict, memberId: item.memberId, sourceRunId: item.sourceRunId, invalidatedAt: item.invalidatedAt })),
      inputRefs: revision.inputRefs || [],
    };
    const blockers = [];
    if (!eligibility || eligibility.versionId !== revision.id || eligibility.status !== 'eligible' || eligibility.valid !== true) blockers.push(eligibility?.reason || '整稿尚未完成程序检查和独立业务审查');
    const currentChecks = (eligibility?.checkIds || []).map(id => checks.find(check => check.id === id));
    if (!currentChecks.length || currentChecks.some(check => !check || check.versionId !== revision.id ||
        check.manifestHash !== revision.manifestHash || check.status !== 'passed' || check.passed !== true || check.invalidatedAt)) blockers.push('固定版本缺少有效的程序检查记录');
    const currentReview = reviews.find(review => review.id === eligibility?.reviewId);
    const reviewRun = currentReview?.sourceRunId && this.store.get('runs', currentReview.sourceRunId);
    const reviewWork = reviewRun?.workItemId && this.store.get('workItems', reviewRun.workItemId);
    if (!currentReview || !(eligibility?.reviewIds || []).includes(currentReview.id) || currentReview.versionId !== revision.id ||
        currentReview.manifestHash !== revision.manifestHash || currentReview.status !== 'current' || currentReview.verdict !== 'approve' ||
        !currentReview.memberId || (revision.authorMemberIds || []).includes(currentReview.memberId) || currentReview.invalidatedAt ||
        reviewRun?.status !== 'succeeded' || reviewRun?.executionSucceeded !== true || reviewRun?.workflowKind !== 'business' ||
        reviewRun?.projectId !== project.id || reviewRun?.memberId !== currentReview.memberId || currentReview.memberId !== project.reviewerId ||
        reviewWork?.kind !== 'review' || reviewWork?.generation !== reviewRun?.generation || reviewWork?.currentAttemptId !== reviewRun?.attemptId) blockers.push('固定版本缺少来源可核验的独立团队审查');
    if (!account?.id || account.platform !== 'xiaohongshu') blockers.push('项目尚未绑定发布账号');
    if (connection.status !== 'ready' || connection.account?.id !== account?.id) blockers.push('当前连接不可用或与项目绑定账号不一致');
    if (!connection.capabilities?.publish) blockers.push('受控发布页能力尚未验证');
    if (account?.connectorVersion !== connection.version) blockers.push('账号的连接器绑定版本已改变，请重新绑定并送审');
    if (payload.visibility !== 'public') blockers.push('此连接器版本尚未验证非公开发布设置');
    if (project.status === 'archived') blockers.push('项目已归档');
    if (timeWindow.endsAt && Date.parse(timeWindow.endsAt) <= this.now()) blockers.push('原发布时间已过，请重新排期并送审');
    if (attempts.some(item => item.status === 'published')) blockers.push('此稿件已有核实通过的发布记录');
    if (attempts.some(ambiguous)) blockers.push('本稿件可能已经提交，必须先核实，不能重复发布');
    if (this.inspectRevision) {
      try {
        const inspection = this.inspectRevision(revision.id);
        if (!inspection.passed || inspection.manifestHash !== revision.manifestHash) blockers.push('当前图片或固定稿件文件未通过复核');
      } catch { blockers.push('当前图片或固定稿件文件未通过复核'); }
    } else blockers.push('实际成果文件复核能力未接入');
    return { ...bundle, contentId, versionId: revision.id, payload, account, timeWindow,
      connector: connection, approvalDigest: digest(fingerprint), canApprove: blockers.length === 0,
      blockers: [...new Set(blockers)], approval, attempt };
  }

  /** Only server/desktop-backend.mjs obtains this closure over its authenticated parent channel. */
  createDesktopApprovalSession({ workspace, desktopSession }) {
    if (path.resolve(workspace) !== this.root || typeof desktopSession !== 'string' || desktopSession.length < 16) throw error('桌面审批上下文无效。', 403);
    const state = { generation: 0, challenges: new Map(), closed: false };
    this.sessions.add(state);
    const invalidate = () => { state.generation++; state.challenges.clear(); };
    const ensure = () => { if (this.closed || state.closed) throw error('桌面审批会话已经结束。', 403); };
    return Object.freeze({
      begin: input => {
        ensure();
        const { contentId, versionId, expectedDigest } = approvalInput.parse(input);
        const preview = this.preview(contentId, versionId);
        if (!preview.canApprove) throw error(preview.blockers.join('；'));
        if (preview.approvalDigest !== expectedDigest) throw error('预览已过期，请查看当前固定整稿后重新确认。');
        const nonce = randomBytes(32).toString('hex');
        const challenge = { nonce, contentId, versionId, expectedDigest, eligibilityRevision: preview.eligibility.revision,
          instanceId: this.instanceId, desktopSession, workspace: this.root, generation: state.generation,
          expiresAt: this.now() + 120000 };
        state.challenges.set(nonce, challenge);
        return { nonce, expiresAt: new Date(challenge.expiresAt).toISOString(), summary: {
          contentId, versionId, approvalDigest: expectedDigest, account: preview.account,
          title: preview.payload.title, imageCount: preview.payload.images.length, timeWindow: preview.timeWindow,
          visibility: preview.payload.visibility, eligibilityRevision: preview.eligibility.revision } };
      },
      confirm: nonce => {
        ensure();
        if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw error('发布确认已失效。', 403);
        const challenge = state.challenges.get(nonce);
        // Repeated parent delivery returns the same durable receipt, without granting a new approval.
        const requestKey = `publication-approval:${digest([this.instanceId, desktopSession, nonce])}`;
        const prior = this.store.db.prepare('SELECT receipt FROM request_keys WHERE request_key=?').get(requestKey);
        if (prior) return JSON.parse(prior.receipt);
        if (!challenge || challenge.generation !== state.generation || challenge.expiresAt < this.now()) throw error('发布确认已超时或页面发生变化，请重新查看整稿。', 403);
        const receipt = this.queue.requestOnce(requestKey, challenge.expectedDigest, () => {
          const preview = this.preview(challenge.contentId, challenge.versionId);
          if (!preview.canApprove || preview.approvalDigest !== challenge.expectedDigest || preview.eligibility.revision !== challenge.eligibilityRevision) throw error('稿件、账号或检查结果已改变，原确认无效。');
          const current = this.store.list('publicationApprovals').find(item => item.contentId === challenge.contentId &&
            item.approvalDigest === challenge.expectedDigest && !terminalApproval.has(item.status));
          if (current) return { approvalId: current.id, contentId: current.contentId, versionId: current.versionId, status: current.status, duplicate: true };
          const time = this.stamp();
          const window = preview.timeWindow.kind === 'immediate'
            ? { kind: 'immediate', startsAt: time, endsAt: new Date(this.now() + 600000).toISOString() } : preview.timeWindow;
          const approval = { id: `approval-${randomUUID()}`, projectId: preview.project.id, contentId: challenge.contentId,
            versionId: challenge.versionId, approvalDigest: challenge.expectedDigest, eligibilityRevision: challenge.eligibilityRevision,
            status: 'approved', account: structuredClone(preview.account), payload: structuredClone(preview.payload),
            manifestHash: preview.revision.manifestHash, connectorVersion: preview.connector.version, timeWindow: window,
            actor: { kind: 'human', channel: 'desktop-native-dialog', sessionId: digest(desktopSession).slice(0, 20) },
            revision: 1, createdAt: time, updatedAt: time };
          this.store.put('publicationApprovals', approval);
          this.store.update('contentItems', approval.contentId, { status: 'approved', publicationApprovalId: approval.id });
          this.queue.enqueueJob({ key: `publication:${approval.id}`, kind: 'publication.send', projectId: approval.projectId,
            payload: { contentId: approval.contentId, versionId: approval.versionId, approvalId: approval.id }, availableAt: window.startsAt });
          this.changed('publication.approved', { approvalId: approval.id, contentId: approval.contentId, versionId: approval.versionId });
          return { approvalId: approval.id, contentId: approval.contentId, versionId: approval.versionId, status: approval.status };
        });
        state.challenges.delete(nonce);
        return receipt;
      },
      cancel: nonce => { if (typeof nonce === 'string') state.challenges.delete(nonce); return { cancelled: true }; },
      invalidate,
      close: () => { invalidate(); state.closed = true; this.sessions.delete(state); },
    });
  }

  revoke(approvalId, reason = '用户撤销了发布安排') {
    return this.store.transaction(() => {
      const approval = this.store.get('publicationApprovals', approvalId);
      if (!approval) throw error('发布批准不存在。', 404);
      const attempt = this.store.list('publicationAttempts').find(item => item.approvalId === approval.id && item.submissionMayHaveOccurred);
      if (attempt) {
        this.store.update('publicationAttempts', attempt.id, { stopRequestedAt: this.stamp(),
          resultWarning: '已经开始执行，可能已提交；停止请求不会撤回平台内容，必须核实' });
        this.changed('publication.stop-requested', { contentId: approval.contentId, attemptId: attempt.id });
        return { revoked: false, submissionMayHaveOccurred: true, attemptId: attempt.id, status: attempt.status };
      }
      if (terminalApproval.has(approval.status)) return { revoked: approval.status === 'revoked', status: approval.status };
      this.store.update('publicationApprovals', approval.id, { status: 'revoked', reason, revision: approval.revision + 1 });
      this.queue.cancelJobs({ contentId: approval.contentId, kind: 'publication.send', reason });
      this.store.update('contentItems', approval.contentId, { status: 'awaiting_approval' });
      this.changed('publication.revoked', { contentId: approval.contentId, approvalId: approval.id });
      return { revoked: true, status: 'revoked' };
    });
  }

  beginSending(job) {
    return this.store.transaction(() => {
      const queued = this.queue.getJob(job.id);
      if (!queued || queued.status !== 'queued') return null;
      const approval = this.store.get('publicationApprovals', job.payload.approvalId);
      if (!approval || terminalApproval.has(approval.status)) { this.queue.cancelJobs({ contentId: job.payload.contentId, kind: 'publication.send', reason: '批准已失效' }); return null; }
      if (Date.parse(approval.timeWindow.endsAt) <= this.now()) {
        this.store.update('publicationApprovals', approval.id, { status: 'expired', reason: '已批准执行窗口已过，需重新排期确认' });
        this.queue.cancelJobs({ contentId: approval.contentId, kind: 'publication.send', reason: '批准已过期' });
        this.store.update('contentItems', approval.contentId, { status: 'awaiting_approval' });
        this.changed('publication.expired', { approvalId: approval.id, contentId: approval.contentId });
        return null;
      }
      const project = this.store.get('projects', approval.projectId);
      if (project?.status !== 'active') return null;
      const live = this.store.list('publicationAttempts');
      if (live.some(item => item.contentId === approval.contentId && (item.submissionMayHaveOccurred || item.status === 'published')) ||
          live.some(item => item.account.id === approval.account.id && ambiguous(item))) return null;
      const preview = this.preview(approval.contentId, approval.versionId);
      if (!preview.canApprove || preview.approvalDigest !== approval.approvalDigest) {
        this.store.update('publicationApprovals', approval.id, { status: 'blocked', reason: preview.blockers.join('；') || '批准版本与当前稿件不一致' });
        this.queue.cancelJobs({ contentId: approval.contentId, kind: 'publication.send', reason: '发送门禁未通过' });
        this.store.update('contentItems', approval.contentId, { status: 'awaiting_approval' });
        this.changed('publication.blocked', { approvalId: approval.id, contentId: approval.contentId });
        return null;
      }
      const claimed = this.queue.claimJob(job.id, { ownerId: this.instanceId, now: this.stamp(), leaseMs: 600000 });
      if (!claimed) return null;
      const attempt = { id: `publication-attempt-${randomUUID()}`, projectId: approval.projectId, contentId: approval.contentId,
        versionId: approval.versionId, approvalId: approval.id, jobId: job.id, leaseToken: claimed.leaseToken,
        approvalDigest: approval.approvalDigest, status: 'sending', submissionMayHaveOccurred: true,
        account: approval.account, payload: approval.payload, connectorVersion: approval.connectorVersion,
        timeWindow: approval.timeWindow, createdAt: this.stamp(), startedAt: this.stamp(), evidence: null,
        verification: { matched: false, findings: ['尚未取得平台创建身份与整稿回读'] } };
      this.store.put('publicationAttempts', attempt);
      this.store.update('publicationApprovals', approval.id, { status: 'sending' });
      this.store.update('contentItems', approval.contentId, { status: 'sending', publicationAttemptId: attempt.id });
      this.changed('publication.sending', { attemptId: attempt.id, contentId: attempt.contentId, submissionMayHaveOccurred: true });
      return attempt;
    });
  }

  tick() {
    if (this.ticking || this.closed) return this.ticking || Promise.resolve();
    this.ticking = (async () => {
      for (const job of this.queue.listJobs({ statuses: ['queued'], kind: 'publication.send' })) {
        if (this.closed || Date.parse(job.availableAt) > this.now()) continue;
        const attempt = this.beginSending(job);
        if (!attempt) continue;
        try {
          const result = await this.connector.publish(attempt);
          this.store.transaction(() => {
            const current = this.store.get('publicationAttempts', attempt.id);
            if (current?.leaseToken !== attempt.leaseToken || current.status !== 'sending') return;
            this.store.update('publicationAttempts', attempt.id, { status: 'verifying', call: result.call, evidence: result.evidence,
              resultWarning: '调用已结束，等待平台身份和整稿核实' });
            this.store.update('contentItems', attempt.contentId, { status: 'verifying' });
            this.changed('publication.verifying', { attemptId: attempt.id, contentId: attempt.contentId });
          });
          await this.verify(attempt.id);
        } catch (failure) { this.markUnknown(attempt.id, failure.message); }
      }
      // Recovery of external operations is read-only. No ambiguous attempt ever re-enters publish().
      for (const attempt of this.store.list('publicationAttempts').filter(item => ['unknown', 'verifying'].includes(item.status))) {
        if (this.closed || attempt.nextVerificationAt && Date.parse(attempt.nextVerificationAt) > this.now()) continue;
        await this.verify(attempt.id).catch(failure => this.markUnknown(attempt.id, failure.message));
      }
    })();
    return this.ticking.finally(() => { this.ticking = null; });
  }

  markUnknown(attemptId, reason) {
    return this.store.transaction(() => {
      const attempt = this.store.get('publicationAttempts', attemptId);
      if (!attempt || attempt.status === 'published' || !attempt.submissionMayHaveOccurred) return attempt;
      const changed = this.store.update('publicationAttempts', attempt.id, { status: 'unknown', resultWarning: String(reason).slice(0, 2000),
        nextVerificationAt: new Date(this.now() + 60000).toISOString(), submissionMayHaveOccurred: true });
      this.store.update('publicationApprovals', attempt.approvalId, { status: 'verifying' });
      this.store.update('contentItems', attempt.contentId, { status: 'unknown' });
      this.queue.finishJob(attempt.jobId, attempt.leaseToken, { status: 'quarantined', error: '外部提交结果未决，仅允许回读核实' });
      this.changed('publication.unknown', { attemptId: attempt.id, contentId: attempt.contentId, submissionMayHaveOccurred: true });
      return changed;
    });
  }

  async verify(attemptId, { noteUrl } = {}) {
    if (noteUrl !== undefined) parseNoteUrl(noteUrl);
    const attempt = this.store.get('publicationAttempts', attemptId) || this.store.list('publicationAttempts').find(item => item.approvalId === attemptId);
    if (!attempt) throw error('发布尝试不存在。', 404);
    if (attempt.status === 'published') return attempt;
    if (!attempt.submissionMayHaveOccurred) throw error('尚未开始提交，无需平台回读。');
    const result = await this.connector.verify(attempt, { noteUrl });
    const evidence = result.evidence || attempt.evidence;
    const verification = verifyPublicationEvidence(attempt, evidence);
    return this.store.transaction(() => {
      const current = this.store.get('publicationAttempts', attempt.id);
      if (current?.status === 'published') return current;
      if (!current || current.approvalDigest !== attempt.approvalDigest) throw error('发布尝试身份已经改变。');
      if (!verification.matched) {
        this.store.update('publicationAttempts', attempt.id, { evidence, verification,
          verificationBlocked: result.blocked || false, connectionStatus: result.connection?.status,
          noteUrl: noteUrl ? `https://www.xiaohongshu.com/explore/${parseNoteUrl(noteUrl).noteId}` : current.noteUrl || null });
        return this.markUnknown(attempt.id, result.reason || verification.findings.join('；'));
      }
      const published = this.store.update('publicationAttempts', attempt.id, { status: 'published', evidence, verification,
        noteId: verification.noteId, publishedAt: this.stamp(), submissionMayHaveOccurred: true, resultWarning: null });
      this.store.update('publicationApprovals', attempt.approvalId, { status: 'published' });
      this.store.update('contentItems', attempt.contentId, { status: 'published', publishedVersionId: attempt.versionId, noteId: verification.noteId });
      this.queue.finishJob(attempt.jobId, attempt.leaseToken, { status: 'succeeded' });
      this.queue.releaseContentSlot(attempt.contentId, { reason: 'published' });
      for (const metric of result.metrics || []) this.store.put('metricsSnapshots', { id: `metric-${randomUUID()}`, ...metric,
        projectId: attempt.projectId, contentId: attempt.contentId, publicationAttemptId: attempt.id });
      this.changed('publication.published', { attemptId: attempt.id, contentId: attempt.contentId, noteId: verification.noteId });
      return published;
    });
  }

  recover() {
    for (const attempt of this.store.list('publicationAttempts')) {
      if (attempt.status === 'sending' || attempt.status === 'verifying') this.markUnknown(attempt.id, '服务已重启，原尝试可能已经提交；恢复后只回读核实');
    }
    for (const state of this.sessions) { state.generation++; state.challenges.clear(); }
  }
  async close() {
    this.closed = true;
    for (const state of this.sessions) { state.closed = true; state.challenges.clear(); }
    await this.ticking?.catch(() => {});
    await this.connector.close?.();
  }
}
