import { DatabaseSync } from 'node:sqlite';
import fs, { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BUSINESS_SCHEMA, BUSINESS_TABLES } from './business-store.mjs';
import { inside } from './safety.mjs';

export const id = (prefix) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
export const WRITER_VERSION = 2;
export const SCHEMA_VERSION = 2;

const schemaError = message => Object.assign(new Error(message), { code: 'WORKSPACE_UPGRADE_BLOCKED', status: 409 });
const privateBackupName = /(^\.env($|\.)|credentials|^controller\.token$|^auth\.json$|^token\.json$|\.pem$|\.key$|id_rsa|id_ed25519)/i;

function assertLegacyQuiescent(db, filename) {
  const directory = path.dirname(filename);
  for (const lockName of ['service.lock', 'scheduler.lock']) {
    const lockPath = path.join(directory, lockName);
    if (!fs.existsSync(lockPath)) continue;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw schemaError('升级前无法核对旧服务归属，请先完全停止旧版'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw schemaError('升级前服务归属无效，请先完全停止旧版');
    if (owner.pid === process.pid) continue;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw schemaError('升级前无法证明旧服务已经退出'); }
    throw schemaError('工作区仍由其他服务使用，请先完全停止旧版再升级');
  }
  const rows = db.prepare(`SELECT kind,data FROM entities WHERE kind IN ('runs','tasks','meetings')`).all();
  for (const row of rows) {
    const value = JSON.parse(row.data);
    if (row.kind === 'runs' && ['queued', 'running', 'verifying', 'starting'].includes(value.status) ||
        row.kind === 'tasks' && ['running', 'verifying'].includes(value.status) ||
        row.kind === 'meetings' && !['complete', 'blocked', 'cancelled'].includes(value.phase)) {
      throw schemaError('旧工作区仍有运行、排队或验收记录；先在旧版停止这些工作，再升级');
    }
  }
}

function snapshotLegacy(db, filename, workspaceRoot) {
  const backupRoot = path.join(path.dirname(filename), 'backups', `schema-1-${Date.now()}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  const databasePath = path.join(backupRoot, 'team.sqlite');
  // This reader observes the WAL snapshot while the migration connection holds the writer lock.
  const reader = new DatabaseSync(filename);
  try { reader.prepare('VACUUM INTO ?').run(databasePath); } finally { reader.close(); }
  const files = [], workspaces = [];
  const tasks = db.prepare(`SELECT data FROM entities WHERE kind='tasks'`).all().map(row => JSON.parse(row.data));
  const base = path.resolve(workspaceRoot || path.join(path.dirname(path.dirname(filename)), 'workspaces'));
  for (const task of tasks) {
    if (!task.workspace) continue;
    const sourceRoot = path.resolve(task.workspace);
    if (!inside(base, sourceRoot) || sourceRoot === base) throw schemaError('旧任务目录超出可备份范围，升级已停止');
  }
  // Capture the entire workspace tree, including room outputs that are not attached to a task.
  // Task IDs, room IDs, drafts and acceptance records remain in the consistent database snapshot.
  workspaces.push({ taskId: 'workspace-root', sourceRoot: base, relativeRoot: '', missing: !fs.existsSync(base) });
  if (fs.existsSync(base)) {
    const sourceRoot = base;
    if (fs.lstatSync(sourceRoot).isSymbolicLink()) throw schemaError('旧工作目录经过链接，升级已停止');
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules', '.team', '__pycache__', '.venv'].includes(entry.name) || privateBackupName.test(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw schemaError('旧任务包含链接，不能生成可信升级快照');
        if (stat.isDirectory()) walk(absolute);
        else if (stat.isFile()) {
          const bytes = fs.readFileSync(absolute);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const objectPath = path.join(backupRoot, 'files', sha256);
          fs.mkdirSync(path.dirname(objectPath), { recursive: true });
          if (!fs.existsSync(objectPath)) fs.writeFileSync(objectPath, bytes, { flag: 'wx', mode: 0o600 });
          files.push({ taskId: 'workspace-root', relativePath: path.relative(sourceRoot, absolute).split(path.sep).join('/'), sha256, size: bytes.length });
        }
      }
    };
    walk(sourceRoot);
  }
  const snapshot = { schemaVersion: 1, createdAt: now(), sourceDatabase: path.resolve(filename), sourceWorkspaceRoot: base,
    database: 'team.sqlite', workspaces, files, excluded: ['CLI/client credentials', 'node_modules', '.git', 'private files'] };
  fs.writeFileSync(path.join(backupRoot, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
  return backupRoot;
}

function installWriterGuards(db) {
  for (const table of ['entities', 'events', 'schema_meta', ...BUSINESS_TABLES]) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
      CREATE TRIGGER IF NOT EXISTS writer_guard_${table}_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} BEGIN
        SELECT CASE WHEN cli_team_writer_version() < CAST((SELECT value FROM schema_meta WHERE key='minimumWriterVersion') AS INTEGER)
          THEN RAISE(ABORT, 'CLI Team writer is too old for this workspace') END;
      END;
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS immutable_content_update BEFORE UPDATE ON entities
      WHEN OLD.kind IN ('contentRevisions','contentAssets') AND (NEW.kind<>OLD.kind OR NEW.id<>OLD.id OR NEW.data<>OLD.data)
      BEGIN SELECT RAISE(ABORT, 'Registered content revisions and assets are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_content_delete BEFORE DELETE ON entities
      WHEN OLD.kind IN ('contentRevisions','contentAssets')
      BEGIN SELECT RAISE(ABORT, 'Registered content revisions and assets are immutable'); END;
  `);
}

/** Restore into a new directory; the upgraded database is never replaced or handed to an old writer. */
export function restoreLegacySnapshot(snapshotRoot, destination) {
  snapshotRoot = fs.realpathSync(snapshotRoot);
  destination = path.resolve(destination);
  const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'snapshot.json'), 'utf8'));
  if (snapshot.schemaVersion !== 1 || inside(destination, snapshot.sourceDatabase) || inside(snapshotRoot, destination) || fs.existsSync(destination)) {
    throw schemaError('旧版快照只能恢复到全新的独立目录');
  }
  fs.mkdirSync(path.join(destination, '.team'), { recursive: true });
  const databasePath = path.join(destination, '.team', 'team.sqlite');
  fs.copyFileSync(path.join(snapshotRoot, 'team.sqlite'), databasePath, fs.constants.COPYFILE_EXCL);
  const workspaceBase = path.join(destination, 'workspaces');
  for (const workspace of snapshot.workspaces) {
    const targetRoot = path.resolve(workspaceBase, workspace.relativeRoot);
    if (!inside(workspaceBase, targetRoot) || targetRoot === workspaceBase && workspace.relativeRoot !== '') throw schemaError('快照任务路径无效');
    if (workspace.missing) continue;
    fs.mkdirSync(targetRoot, { recursive: true });
    for (const file of snapshot.files.filter(item => item.taskId === workspace.taskId)) {
      const target = path.resolve(targetRoot, file.relativePath);
      if (!inside(targetRoot, target) || target === targetRoot || !/^[a-f0-9]{64}$/.test(file.sha256)) throw schemaError('快照文件路径无效');
      const bytes = fs.readFileSync(path.join(snapshotRoot, 'files', file.sha256));
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw schemaError('升级快照文件已变化');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
  }
  const restored = new DatabaseSync(databasePath);
  const replacePath = value => {
    if (typeof value === 'string') {
      for (const workspace of snapshot.workspaces) if (value === workspace.sourceRoot || value.startsWith(`${workspace.sourceRoot}${path.sep}`) || value.startsWith(`${workspace.sourceRoot}/`)) {
        return path.join(workspaceBase, workspace.relativeRoot, path.relative(workspace.sourceRoot, value));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(replacePath);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replacePath(child)]));
    return value;
  };
  try {
    restored.exec('BEGIN IMMEDIATE');
    for (const row of restored.prepare('SELECT kind,id,data FROM entities').all()) {
      restored.prepare('UPDATE entities SET data=? WHERE kind=? AND id=?').run(JSON.stringify(replacePath(JSON.parse(row.data))), row.kind, row.id);
    }
    restored.exec('COMMIT');
  } catch (error) { restored.exec('ROLLBACK'); throw error; } finally { restored.close(); }
  return { root: destination, dataDir: path.dirname(databasePath), workspaceRoot: workspaceBase, databasePath };
}

export class Store {
  constructor(filename, { workspaceRoot } = {}) {
    this.transactions = [];
    this.filename = filename;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.function('cli_team_writer_version', { deterministic: true }, () => WRITER_VERSION);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      const tables = new Set(this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name));
      const version = tables.has('schema_meta') ? Number(this.db.prepare(`SELECT value FROM schema_meta WHERE key='schemaVersion'`).get()?.value || 0) : 0;
      const minimum = tables.has('schema_meta') ? Number(this.db.prepare(`SELECT value FROM schema_meta WHERE key='minimumWriterVersion'`).get()?.value || 0) : 0;
      if (version > SCHEMA_VERSION || minimum > WRITER_VERSION) throw schemaError('此工作区需要更新版本的 CLI Team，当前程序拒绝写入');
      if (version < SCHEMA_VERSION) {
        const legacy = tables.has('entities');
        let migrationLock, lockPath;
        if (filename !== ':memory:') {
          lockPath = `${filename}.migration.lock`;
          try { migrationLock = fs.openSync(lockPath, 'wx', 0o600); }
          catch (error) { if (error.code === 'EEXIST') throw schemaError('工作区升级正在进行或尚未清理，请核对升级进程后重试'); throw error; }
          fs.writeFileSync(migrationLock, JSON.stringify({ pid: process.pid, createdAt: now() }));
        }
        try {
          this.db.exec('BEGIN EXCLUSIVE');
          if (legacy) {
            assertLegacyQuiescent(this.db, filename);
            if (filename !== ':memory:') this.migrationBackup = snapshotLegacy(this.db, filename, workspaceRoot);
          }
          this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(kind, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_by_room
        ON entities(json_extract(data, '$.roomId')) WHERE kind = 'messages';
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
          this.db.exec(BUSINESS_SCHEMA);
          for (const [key, value] of Object.entries({ schemaVersion: String(SCHEMA_VERSION), minimumWriterVersion: String(WRITER_VERSION), migratedAt: now() })) {
            this.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
          }
          installWriterGuards(this.db);
          this.db.exec('COMMIT');
        } catch (error) {
          if (this.db.isTransaction) this.db.exec('ROLLBACK');
          throw error;
        } finally {
          if (migrationLock !== undefined) { fs.closeSync(migrationLock); fs.unlinkSync(lockPath); }
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  get(kind, entityId) {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, entityId);
    return row ? JSON.parse(row.data) : null;
  }
  list(kind) {
    return this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid').all(kind).map((row) => JSON.parse(row.data));
  }
  roomMessages(roomId, { limit, before, after, includeArchived }) {
    const cursor = before || after;
    const boundary = cursor && this.db.prepare(`
      SELECT rowid AS sequence, json_extract(data, '$.roomId') AS roomId
      FROM entities WHERE kind = 'messages' AND id = ?
    `).get(cursor);
    if (cursor && (!boundary || boundary.roomId !== roomId)) {
      throw Object.assign(new Error('聊天记录位置无效或不属于当前房间，请重新加载'), { status: 400 });
    }
    const rows = this.db.prepare(`
      SELECT message.rowid AS sequence, message.data
      FROM entities AS message
      WHERE message.kind = 'messages' AND json_extract(message.data, '$.roomId') = ?
        ${cursor ? `AND message.rowid ${after ? '>' : '<'} ?` : ''}
        AND (? = 1 OR NOT EXISTS (
          SELECT 1 FROM entities AS task WHERE task.kind = 'tasks'
            AND task.id = json_extract(message.data, '$.taskId')
            AND coalesce(json_extract(task.data, '$.archivedAt'), '') <> ''
        ))
      ORDER BY message.rowid ${after ? 'ASC' : 'DESC'} LIMIT ?
    `).all(roomId, ...(cursor ? [boundary.sequence] : []), includeArchived ? 1 : 0, limit + 1);
    const messages = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.data), sequence: Number(row.sequence) }));
    if (!after) messages.reverse();
    // Messages are immutable. Only task/room archiving can change the visibility
    // of earlier rows, so clients can append normally and rebuild on this key.
    const hiddenTasks = includeArchived ? [] : this.db.prepare(`
      SELECT id FROM entities WHERE kind = 'tasks' AND json_extract(data, '$.roomId') = ?
        AND coalesce(json_extract(data, '$.archivedAt'), '') <> '' ORDER BY id
    `).all(roomId).map(row => row.id);
    return {
      roomId, messages, hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? (after ? messages.at(-1).id : messages[0].id) : null,
      visibilityKey: createHash('sha256').update(JSON.stringify([includeArchived, hiddenTasks])).digest('hex'),
    };
  }
  put(kind, entity) {
    this.db.prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data')
      .run(kind, entity.id, JSON.stringify(entity));
    return entity;
  }
  update(kind, entityId, patch) {
    const previous = this.get(kind, entityId);
    if (!previous) throw Object.assign(new Error('记录不存在'), { status: 404 });
    return this.put(kind, { ...previous, ...patch, id: entityId, updatedAt: now() });
  }
  remove(kind, entityId) {
    this.db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?').run(kind, entityId);
  }
  event(type, payload) {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(type,payload,created_at) VALUES(?,?,?)')
      .run(type, JSON.stringify(payload), createdAt);
    return { type, payload, revision: Number(result.lastInsertRowid), createdAt };
  }
  transaction(callback) {
    if (callback.constructor.name === 'AsyncFunction') throw new Error('状态事务必须同步完成');
    const name = `state_${this.transactionSequence = (this.transactionSequence || 0) + 1}`;
    // Reserve the writer before reading a deduplication/budget record. Deferred
    // read transactions can otherwise race a second process and fail upgrading
    // a stale WAL snapshot to a writer after both observed the same free slot.
    const ownsTransaction = !this.db.isTransaction;
    this.db.exec(ownsTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    const effects = [];
    this.transactions.push(effects);
    let result;
    try {
      result = callback();
      if (result && typeof result.then === 'function') throw new Error('状态事务必须同步完成');
      this.db.exec(ownsTransaction ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
    } catch (error) {
      if (ownsTransaction) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
      else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
      }
      this.transactions.pop();
      throw error;
    }
    this.transactions.pop();
    if (this.transactions.length) this.transactions.at(-1).push(...effects);
    else for (const effect of effects) effect();
    return result;
  }
  afterCommit(callback) {
    if (this.transactions.length) this.transactions.at(-1).push(callback);
    else callback();
  }
  close() { this.db.close(); }
}
