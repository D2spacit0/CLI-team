import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const id = (prefix) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();

export class Store {
  constructor(filename) {
    this.transactions = [];
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
    `);
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
    this.db.exec(`SAVEPOINT ${name}`);
    const effects = [];
    this.transactions.push(effects);
    let result;
    try {
      result = callback();
      if (result && typeof result.then === 'function') throw new Error('状态事务必须同步完成');
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.db.exec(`RELEASE SAVEPOINT ${name}`);
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
