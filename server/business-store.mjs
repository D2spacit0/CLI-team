import { randomUUID } from 'node:crypto';

export const BUSINESS_TABLES = Object.freeze(['jobs', 'resource_leases', 'request_keys', 'budget_ledger']);
export const BUSINESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    project_id TEXT, work_item_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', available_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, owner_id TEXT, lease_token TEXT, lease_until TEXT,
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, available_at, created_at);
  CREATE INDEX IF NOT EXISTS jobs_work ON jobs(work_item_id, generation);
  CREATE TABLE IF NOT EXISTS resource_leases (
    resource TEXT PRIMARY KEY, owner_id TEXT NOT NULL, run_id TEXT,
    token TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS request_keys (
    request_key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS budget_ledger (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, day TEXT NOT NULL,
    kind TEXT NOT NULL, request_key TEXT NOT NULL, content_id TEXT,
    amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL,
    started INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, released_at TEXT,
    UNIQUE(project_id, kind, request_key)
  );
  CREATE INDEX IF NOT EXISTS budget_day ON budget_ledger(project_id, day, kind, status);
  CREATE UNIQUE INDEX IF NOT EXISTS content_slot_identity ON budget_ledger(content_id)
    WHERE kind = 'content_slot';
  CREATE UNIQUE INDEX IF NOT EXISTS production_cycle_day ON entities(
    json_extract(data, '$.projectId'), json_extract(data, '$.day')) WHERE kind = 'productionCycles';
  CREATE UNIQUE INDEX IF NOT EXISTS production_cycle_active ON entities(json_extract(data, '$.projectId'))
    WHERE kind = 'productionCycles' AND json_extract(data, '$.status') = 'active';
  CREATE UNIQUE INDEX IF NOT EXISTS publication_attempt_approval ON entities(json_extract(data, '$.approvalId'))
    WHERE kind = 'publicationAttempts';
`;

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const stamp = () => new Date().toISOString();
const required = (value, label) => {
  if (typeof value !== 'string' || !value || value.length > 1000) fail(`${label}无效`, 400);
  return value;
};
const jobRecord = row => row ? {
  id: row.id, key: row.job_key, kind: row.kind, projectId: row.project_id, workItemId: row.work_item_id,
  generation: row.generation, payload: JSON.parse(row.payload), status: row.status, availableAt: row.available_at,
  attempts: row.attempts, ownerId: row.owner_id, leaseToken: row.lease_token, leaseUntil: row.lease_until,
  error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
} : null;
const budgetRecord = row => row ? {
  id: row.id, projectId: row.project_id, day: row.day, kind: row.kind, key: row.request_key,
  contentId: row.content_id, amount: row.amount, status: row.status, started: Boolean(row.started),
  createdAt: row.created_at, releasedAt: row.released_at,
} : null;

/** Durable outbox and resource reservations. Expiry is diagnostic, never proof that a child exited. */
export class BusinessStore {
  constructor(store) { this.store = store; this.db = store.db; }

  enqueueJob({ key, kind, projectId = null, workItemId = null, payload = {}, availableAt = stamp(), generation = 0 }) {
    required(key, '作业唯一键'); required(kind, '作业类型');
    if (!Number.isInteger(generation) || generation < 0 || !Number.isFinite(Date.parse(availableAt))) fail('作业版本或时间无效', 400);
    return this.store.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE job_key = ?').get(key);
      if (existing) {
        const result = jobRecord(existing);
        if (result.kind !== kind || result.projectId !== projectId || result.workItemId !== workItemId ||
            result.generation !== generation || JSON.stringify(result.payload) !== JSON.stringify(payload)) fail('作业唯一键已经用于不同输入');
        return result;
      }
      const time = stamp();
      const jobId = `job-${randomUUID()}`;
      this.db.prepare(`INSERT INTO jobs(id,job_key,kind,project_id,work_item_id,generation,payload,available_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(jobId, key, kind, projectId, workItemId, generation, JSON.stringify(payload), new Date(availableAt).toISOString(), time, time);
      return this.getJob(jobId);
    });
  }

  getJob(jobId) { return jobRecord(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)); }

  listJobs({ statuses, kind } = {}) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY available_at, created_at, rowid').all()
      .map(jobRecord).filter(job => (!statuses || statuses.includes(job.status)) && (!kind || job.kind === kind));
  }

  claimJob(jobId, { ownerId, leaseToken = randomUUID(), now = stamp(), leaseMs = 600000 }) {
    required(ownerId, '队列所有者'); required(leaseToken, '租约凭据');
    const time = new Date(now).toISOString();
    const result = this.db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1, owner_id=?, lease_token=?,
      lease_until=?, updated_at=? WHERE id=? AND status='queued' AND available_at<=?`)
      .run(ownerId, leaseToken, new Date(Date.parse(time) + leaseMs).toISOString(), time, jobId, time);
    return result.changes ? this.getJob(jobId) : null;
  }

  finishJob(jobId, leaseToken, { status = 'succeeded', error = null } = {}) {
    if (!['succeeded', 'failed', 'cancelled', 'quarantined'].includes(status)) fail('作业终态无效', 400);
    const result = this.db.prepare(`UPDATE jobs SET status=?,error=?,updated_at=?
      WHERE id=? AND status='running' AND lease_token=?`).run(status, error, stamp(), jobId, leaseToken);
    return Boolean(result.changes);
  }

  deferJob(jobId, { availableAt, reason = null } = {}) {
    const result = this.db.prepare(`UPDATE jobs SET available_at=?,error=?,updated_at=? WHERE id=? AND status='queued'`)
      .run(new Date(availableAt).toISOString(), reason, stamp(), jobId);
    return Boolean(result.changes);
  }

  requeueJob(jobId, { availableAt = stamp(), error = null, confirmedNotStarted = false } = {}) {
    const job = this.getJob(jobId);
    if (!job || !['queued', 'running'].includes(job.status)) return false;
    if (job.status === 'running' && !confirmedNotStarted) fail('启动情况未确认的作业不能重新派发');
    return Boolean(this.db.prepare(`UPDATE jobs SET status='queued',available_at=?,error=?,owner_id=NULL,lease_token=NULL,
      lease_until=NULL,updated_at=? WHERE id=? AND status=? AND lease_token IS ?`)
      .run(new Date(availableAt).toISOString(), error, stamp(), jobId, job.status, job.leaseToken).changes);
  }

  cancelJob(jobId, { reason = '相关工作已经取消' } = {}) {
    return Boolean(this.db.prepare(`UPDATE jobs SET status='cancelled',error=?,updated_at=? WHERE id=? AND status='queued'`)
      .run(reason, stamp(), jobId).changes);
  }

  cancelJobs({ projectId, workItemId, contentId, kind, reason = '相关输入已经失效' } = {}) {
    let count = 0;
    for (const job of this.listJobs({ statuses: ['queued'] })) {
      if (projectId && job.projectId !== projectId || workItemId && job.workItemId !== workItemId ||
          contentId && job.payload.contentId !== contentId || kind && job.kind !== kind) continue;
      count += Number(this.db.prepare(`UPDATE jobs SET status='cancelled',error=?,updated_at=? WHERE id=? AND status='queued'`)
        .run(reason, stamp(), job.id).changes);
    }
    return count;
  }

  acquireLease(resource, { ownerId, runId = null, generation, ttlMs = 600000 }) {
    required(resource, '资源'); required(ownerId, '资源所有者');
    if (!Number.isInteger(generation) || generation < 0) fail('资源 generation 无效', 400);
    const token = randomUUID(), time = stamp();
    const result = this.db.prepare(`INSERT INTO resource_leases(resource,owner_id,run_id,token,generation,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(resource) DO NOTHING`)
      .run(resource, ownerId, runId, token, generation, new Date(Date.now() + ttlMs).toISOString(), time);
    return result.changes ? { resource, ownerId, runId, token, generation, expiresAt: new Date(Date.now() + ttlMs).toISOString() } : null;
  }

  isLeaseCurrent(resource, token, generation) {
    const row = this.db.prepare('SELECT token,generation FROM resource_leases WHERE resource=?').get(resource);
    return Boolean(row && row.token === token && (generation === undefined || row.generation === generation));
  }

  releaseLease(resource, token) {
    return Boolean(this.db.prepare('DELETE FROM resource_leases WHERE resource=? AND token=?').run(resource, token).changes);
  }

  listLeases() {
    return this.db.prepare('SELECT * FROM resource_leases').all().map(row => ({ resource: row.resource,
      ownerId: row.owner_id, runId: row.run_id, token: row.token, generation: row.generation,
      expiresAt: row.expires_at, createdAt: row.created_at }));
  }

  requestOnce(key, digest, callback) {
    required(key, '请求唯一键'); required(digest, '请求摘要');
    return this.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM request_keys WHERE request_key=?').get(key);
      if (previous) {
        if (previous.digest !== digest) fail('该请求已经用于其他内容');
        return JSON.parse(previous.receipt);
      }
      const receipt = callback();
      if (receipt && typeof receipt.then === 'function') throw new Error('唯一请求回调必须同步完成');
      this.db.prepare('INSERT INTO request_keys(request_key,digest,receipt,created_at) VALUES(?,?,?,?)')
        .run(key, digest, JSON.stringify(receipt ?? null), stamp());
      return receipt;
    });
  }

  reserveBudget({ projectId, day, key, limit = 24, kind = 'cli', amount = 1 }) {
    required(projectId, '项目'); required(day, '自然日'); required(key, '预算唯一键');
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(amount) || amount < 1 || kind === 'content_slot') fail('预算范围无效', 400);
    return this.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM budget_ledger WHERE project_id=? AND kind=? AND request_key=?').get(projectId, kind, key);
      if (previous) {
        if (previous.day !== day || previous.amount !== amount || previous.status === 'released') fail('预算唯一键与已有预留不一致');
        return budgetRecord(previous);
      }
      const entryId = `budget-${randomUUID()}`;
      const result = this.db.prepare(`INSERT INTO budget_ledger(id,project_id,day,kind,request_key,amount,status,created_at)
        SELECT ?,?,?,?,?,?,'reserved',? WHERE (SELECT coalesce(sum(amount),0) FROM budget_ledger
          WHERE project_id=? AND day=? AND kind=? AND status<>'released') + ? <= ?`)
        .run(entryId, projectId, day, kind, key, amount, stamp(), projectId, day, kind, amount, limit);
      return result.changes ? budgetRecord(this.db.prepare('SELECT * FROM budget_ledger WHERE id=?').get(entryId)) : null;
    });
  }

  markBudgetStarted(entryId) {
    return Boolean(this.db.prepare(`UPDATE budget_ledger SET started=1,status='consumed' WHERE id=? AND status<>'released'`).run(entryId).changes);
  }

  releaseUnstartedBudget(entryId, { confirmedNotStarted = false } = {}) {
    if (!confirmedNotStarted) fail('只有确认未启动的调用才可退回预算');
    return Boolean(this.db.prepare(`UPDATE budget_ledger SET status='released',released_at=? WHERE id=? AND started=0 AND status='reserved'`)
      .run(stamp(), entryId).changes);
  }

  reserveContentSlot({ projectId, contentId, limit = 3 }) {
    required(projectId, '项目'); required(contentId, '稿件');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail('稿件名额无效', 400);
    return this.store.transaction(() => {
      const previous = this.db.prepare(`SELECT * FROM budget_ledger WHERE kind='content_slot' AND content_id=?`).get(contentId);
      if (previous) return previous.project_id === projectId && previous.status !== 'released';
      const result = this.db.prepare(`INSERT INTO budget_ledger(id,project_id,day,kind,request_key,content_id,amount,status,created_at)
        SELECT ?,?,'*','content_slot',?,?,1,'reserved',? WHERE
          (SELECT coalesce(sum(amount),0) FROM budget_ledger WHERE project_id=? AND kind='content_slot' AND status<>'released') < ?`)
        .run(`slot-${randomUUID()}`, projectId, `content:${contentId}`, contentId, stamp(), projectId, limit);
      return Boolean(result.changes);
    });
  }

  releaseContentSlot(contentId, { reason, submissionMayHaveOccurred = false } = {}) {
    if (!['published', 'abandoned'].includes(reason)) fail('只有核实发布或明确放弃才释放稿件名额');
    const attempts = this.store.list('publicationAttempts').filter(attempt => attempt.contentId === contentId);
    if (reason === 'published' && !attempts.some(attempt => attempt.status === 'published' && attempt.verification?.matched === true)) {
      fail('尚无核实通过的发布记录，不能释放名额');
    }
    if (reason === 'abandoned' && (submissionMayHaveOccurred || attempts.some(attempt => attempt.submissionMayHaveOccurred && attempt.status !== 'published'))) {
      fail('外部提交结果未决，不能释放稿件名额');
    }
    return Boolean(this.db.prepare(`UPDATE budget_ledger SET status='released',released_at=? WHERE content_id=? AND kind='content_slot' AND status<>'released'`)
      .run(stamp(), contentId).changes);
  }

  budgetUsage(projectId, day) {
    const rows = this.db.prepare(`SELECT * FROM budget_ledger WHERE project_id=? AND (day=? OR kind='content_slot')`).all(projectId, day);
    return { cliCalls: rows.filter(row => row.kind === 'cli' && row.status !== 'released').reduce((sum, row) => sum + row.amount, 0),
      contentSlots: rows.filter(row => row.kind === 'content_slot' && row.status !== 'released').reduce((sum, row) => sum + row.amount, 0),
      entries: rows.map(budgetRecord) };
  }
}
