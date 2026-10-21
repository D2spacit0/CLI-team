import type { HistoryMessage, MessagePage } from '../types';

export type PageQuery = { before?: string; after?: string };
export type PageReader = (roomId: string, query?: PageQuery) => Promise<MessagePage>;
export interface HistoryState {
  messages: HistoryMessage[];
  ready: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: string | null;
  olderError: string | null;
}

export const emptyHistory: HistoryState = {
  messages: [], ready: false, loading: false, loadingOlder: false,
  hasOlder: false, error: null, olderError: null,
};

function mergeMessages(...sources: HistoryMessage[][]) {
  const messages = new Map<string, HistoryMessage>();
  for (const source of sources) for (const message of source) messages.set(message.id, message);
  return [...messages.values()].sort((left, right) => left.sequence - right.sequence);
}

function errorText(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError') return '读取聊天记录超时，请重试';
  return error instanceof Error ? error.message : '聊天记录读取失败，请重试';
}

// One entry owns all requests for one room. Switching rooms changes the
// subscription, so an old response cannot replace the new room's messages.
export class RoomHistory {
  readonly roomId: string;
  private reader: PageReader;
  private state = emptyHistory;
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private refreshPending = false;
  private visibilityKey: string | null = null;
  private rangeStart: number | null = null;

  constructor(roomId: string, reader: PageReader) {
    this.roomId = roomId;
    this.reader = reader;
  }

  getSnapshot = () => this.state;
  get observed() { return this.listeners.size > 0; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<HistoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  refresh = () => this.run('refresh');
  loadOlder = () => {
    if (!this.state.ready || !this.state.hasOlder) return Promise.resolve();
    return this.run('older');
  };

  private run(operation: 'refresh' | 'older'): Promise<void> {
    if (this.running) {
      if (operation === 'refresh') this.refreshPending = true;
      return this.running;
    }
    this.running = Promise.resolve().then(async () => {
      do {
        if (operation === 'refresh') this.refreshPending = false;
        const older = operation === 'older';
        this.publish(older ? { loadingOlder: true, olderError: null } : { loading: true, error: null });
        try {
          if (older) await this.readOlder();
          else await this.readNewer();
        } catch (error) {
          this.publish(older ? { olderError: errorText(error) } : { error: errorText(error) });
        } finally {
          this.publish({ loading: false, loadingOlder: false });
        }
        operation = 'refresh';
      } while (this.refreshPending);
    }).finally(() => {
      this.running = null;
      // A refresh can arrive in the microtask between completion and cleanup.
      if (this.refreshPending) return this.refresh();
    });
    return this.running;
  }

  private async page(query: PageQuery = {}) {
    const page = await this.reader(this.roomId, query);
    if (page.roomId !== this.roomId || page.messages.some(message => message.roomId !== this.roomId)) {
      throw new Error('聊天记录与当前房间不一致，请重试加载');
    }
    if (page.hasMore && (!page.messages.length || !page.nextCursor || page.nextCursor === (query.before || query.after))) {
      throw new Error('聊天分页位置无效，请重试加载');
    }
    return page;
  }

  private async readNewer() {
    const latest = this.state.messages.at(-1);
    if (!this.state.ready || !latest) { await this.reloadRange(); return; }
    let after = latest.id;
    for (;;) {
      const page = await this.page({ after });
      if (page.visibilityKey !== this.visibilityKey) { await this.reloadRange(); return; }
      if (page.messages.length) this.publish({ messages: mergeMessages(this.state.messages, page.messages) });
      if (!page.hasMore) return;
      after = page.nextCursor!;
    }
  }

  private async readOlder(reloaded = false): Promise<void> {
    const earliest = this.state.messages[0];
    if (!earliest || !this.state.hasOlder) return;
    const page = await this.page({ before: earliest.id });
    if (page.visibilityKey !== this.visibilityKey) {
      if (reloaded) throw new Error('记录在加载期间发生归档或恢复，请重试加载');
      await this.reloadRange();
      await this.readOlder(true);
      return;
    }
    const messages = mergeMessages(page.messages, this.state.messages);
    this.rangeStart = Math.min(this.rangeStart ?? earliest.sequence, messages[0].sequence);
    this.publish({ messages, hasOlder: page.hasMore });
  }

  private async reloadRange() {
    // A visibility change rebuilds the already opened range atomically. Keep
    // its original boundary even if its oldest message has become archived.
    for (let attempt = 0; attempt < 2; attempt++) {
      let page = await this.page();
      const visibilityKey = page.visibilityKey;
      const pages = [page.messages];
      let changed = false;
      while (page.hasMore && this.rangeStart !== null && page.messages[0].sequence > this.rangeStart) {
        page = await this.page({ before: page.nextCursor! });
        if (page.visibilityKey !== visibilityKey) { changed = true; break; }
        pages.push(page.messages);
      }
      if (changed) continue;
      const messages = mergeMessages(...pages);
      if (messages.length) this.rangeStart = Math.min(this.rangeStart ?? messages[0].sequence, messages[0].sequence);
      this.visibilityKey = visibilityKey;
      this.publish({ messages, ready: true, hasOlder: page.hasMore, error: null, olderError: null });
      return;
    }
    throw new Error('记录在加载期间发生归档或恢复，请重试加载');
  }
}

export class RoomHistoryCache {
  private entries = new Map<string, RoomHistory>();
  private reader: PageReader;
  private capacity: number;

  constructor(reader: PageReader, capacity = 8) {
    this.reader = reader;
    this.capacity = capacity;
  }
  get(workspace: string, roomId: string) {
    const key = JSON.stringify([workspace, roomId]);
    const entry = this.entries.get(key) || new RoomHistory(roomId, this.reader);
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const [oldKey, oldEntry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (oldKey !== key && !oldEntry.observed) this.entries.delete(oldKey);
    }
    return entry;
  }
}
