import { useEffect, useMemo, useSyncExternalStore } from 'react';

export type TaskDraftScope =
  | { kind: 'new-task'; contextId?: string }
  | { kind: 'room-create' }
  | { kind: 'meeting-create'; roomId: string }
  | { kind: 'room-message'; roomId: string }
  | { kind: 'managed-request'; roomId: string }
  | { kind: 'revision' | 'acceptance' | 'assignment'; taskId: string; planId?: string; contextId?: string }
  | { kind: 'assistance'; taskId: string; planId: string; questionId: string };
export type TaskDraftValues = Record<string, string>;
export interface TaskDraftSnapshot {
  values: TaskDraftValues; ready: boolean; loaded: boolean; saving: boolean; restored: boolean; error: string;
}
type DraftResponse = { workspace: string; revision: number; draft: { values: TaskDraftValues; updatedAt: string } | null };
type Transport = (url: string, options: RequestInit) => Promise<Response>;
type Mutation = { kind: 'write'; changes: TaskDraftValues; version: number }
  | { kind: 'clear'; version: number; finish: (saved: boolean) => void; settled?: boolean };
const fields: Record<TaskDraftScope['kind'], readonly string[]> = {
  'new-task': ['title', 'objective', 'requirements', 'verificationCommand', 'executionMode', 'assigneeId', 'reviewerId',
    'participantIds', 'roomId', 'sourceSessionId', 'sourceTitle', 'preparationTaskId', 'materialManifest', 'creationRequestId'],
  revision: ['feedback'], acceptance: ['note'], assistance: ['answer'],
  assignment: ['assigneeId', 'reviewerId', 'participantIds', 'note'],
  'room-message': ['body', 'recipientIds', 'taskId', 'sendRequestId'],
  'managed-request': ['objective', 'requestId'],
  'room-create': ['name', 'requestId'],
  'meeting-create': ['objective', 'memberIds', 'requestId'],
};
function normalizedScope(scope: TaskDraftScope): TaskDraftScope {
  if (scope.kind === 'new-task') return { kind: scope.kind, contextId: scope.contextId || 'default' };
  if (scope.kind === 'room-create') return { kind: scope.kind };
  if (scope.kind === 'room-message' || scope.kind === 'managed-request' || scope.kind === 'meeting-create') return { kind: scope.kind, roomId: scope.roomId };
  if (scope.kind === 'assistance') return { kind: scope.kind, taskId: scope.taskId, planId: scope.planId, questionId: scope.questionId };
  return { kind: scope.kind, taskId: scope.taskId, planId: scope.planId || '', contextId: scope.contextId || '' };
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '草稿保存失败';

class DraftEntry {
  readonly workspace: string;
  readonly scope: TaskDraftScope;
  private defaults: TaskDraftValues;
  private requestedDefaults: TaskDraftValues;
  private readonly transport: Transport;
  private persisted: TaskDraftValues;
  private local = new Map<string, { value: string; version: number }>();
  private listeners = new Set<() => void>();
  private queue: Mutation[] = [];
  private revision = 0;
  private version = 0;
  private loaded = false;
  private hasLoadedBase = false;
  private hasStoredDraft = false;
  private conflict = false;
  private failedClear: Extract<Mutation, { kind: 'clear' }> | null = null;
  private loading: Promise<boolean> | null = null;
  private running: Promise<boolean> | null = null;
  private state: TaskDraftSnapshot;

  constructor(workspace: string, scope: TaskDraftScope, defaults: TaskDraftValues, transport: Transport) {
    this.workspace = workspace;
    this.scope = normalizedScope(scope);
    this.defaults = this.validFields(defaults) ? { ...defaults } : {};
    this.requestedDefaults = { ...this.defaults };
    this.persisted = { ...this.defaults };
    this.transport = transport;
    this.state = { values: { ...this.defaults }, ready: false, loaded: false, saving: false, restored: false, error: '' };
  }
  private validFields(values: TaskDraftValues) {
    return values && typeof values === 'object' && !Array.isArray(values) &&
      Object.entries(values).every(([key, value]) => fields[this.scope.kind].includes(key) && typeof value === 'string');
  }
  updateDefaults(defaults: TaskDraftValues) {
    if (!this.validFields(defaults)) return;
    this.requestedDefaults = { ...defaults };
    if (this.adoptDefaults()) this.publish();
  }
  private adoptDefaults() {
    if (!this.loaded || this.hasStoredDraft || this.local.size || this.queue.length || this.failedClear || this.running || this.loading) return false;
    if (Object.keys(this.defaults).length === Object.keys(this.requestedDefaults).length &&
        Object.entries(this.requestedDefaults).every(([key, value]) => this.defaults[key] === value)) return false;
    this.defaults = { ...this.requestedDefaults };
    this.persisted = { ...this.defaults };
    return true;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<TaskDraftSnapshot> = {}) {
    const values = { ...this.persisted };
    for (const [key, item] of this.local) values[key] = item.value;
    this.state = { ...this.state, ...patch, values, loaded: this.loaded };
    for (const listener of this.listeners) listener();
  }
  private async request(action: 'read' | 'write' | 'clear', extra: Record<string, unknown> = {}) {
    const response = await this.transport(action === 'read' ? '/api/ui-drafts/read' : '/api/ui-drafts', {
      method: action === 'read' ? 'POST' : action === 'write' ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: this.workspace, scope: this.scope, ...extra }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : '草稿服务请求失败'), { status: response.status });
    if (data?.workspace !== this.workspace || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        (data.draft !== null && (!data.draft || !this.validFields(data.draft.values)))) throw new Error('草稿响应与当前工作区不匹配');
    return data as DraftResponse;
  }
  load = (): Promise<boolean> => {
    if (this.loaded) return Promise.resolve(true);
    if (this.loading) return this.loading;
    this.loading = this.request('read').then((data) => {
      this.revision = data.revision;
      this.persisted = { ...this.defaults, ...data.draft?.values };
      this.loaded = true;
      this.hasLoadedBase = true;
      this.hasStoredDraft = Boolean(data.draft);
      this.publish({ ready: true, restored: Boolean(data.draft), error: '' });
      return true;
    }).catch((error: unknown) => {
      this.publish({ ready: true, saving: false, error: `草稿尚未恢复：${errorText(error)}。当前输入仍保留在本窗口。` });
      return false;
    }).finally(() => { this.loading = null; if (this.adoptDefaults()) this.publish(); });
    return this.loading;
  };
  private compactWrites() {
    const merged: Mutation[] = [];
    for (const operation of this.queue) {
      const last = merged.at(-1);
      if (last?.kind === 'write' && operation.kind === 'write') {
        last.changes = { ...last.changes, ...operation.changes };
        last.version = operation.version;
      } else merged.push(operation);
    }
    this.queue = merged;
  }
  private retainedValues() {
    return this.hasLoadedBase ? this.state.values : Object.fromEntries([...this.local].map(([key, item]) => [key, item.value]));
  }
  private holdFailedClear(operation: Extract<Mutation, { kind: 'clear' }>) {
    if (operation.settled) return;
    operation.settled = true;
    this.queue = this.queue.filter((queued) => queued !== operation);
    this.failedClear = operation;
    const next = this.queue.at(-1);
    // Editing after a failed discard resumes the complete draft, including
    // unchanged preparation IDs. Ordinary autosave must never retry a DELETE.
    if (next?.kind === 'write' && next.version > operation.version) {
      const changes = { ...this.retainedValues() }, version = ++this.version;
      for (const [key, value] of Object.entries(changes)) this.local.set(key, { value, version });
      this.queue.push({ kind: 'write', changes, version });
      this.compactWrites();
      this.failedClear = null;
    }
    operation.finish(false);
  }
  setValues = (values: TaskDraftValues) => {
    if (!this.validFields(values)) { this.publish({ error: '草稿只接受指定的文字和准备信息，不能保存执行或验收授权。' }); return; }
    let changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => this.state.values[key] !== value));
    if (!Object.keys(changes).length) return;
    if (this.failedClear) {
      changes = { ...this.retainedValues(), ...changes };
      this.failedClear = null;
    }
    const version = ++this.version;
    for (const [key, value] of Object.entries(changes)) this.local.set(key, { value, version });
    this.queue.push({ kind: 'write', changes, version });
    this.compactWrites();
    this.publish({ saving: !this.conflict, error: this.conflict ? this.state.error : '' });
    void this.flush();
  };
  setField = (name: string, value: string) => this.setValues({ [name]: value });
  hasPending = () => this.queue.length > 0 || Boolean(this.running) || Boolean(this.failedClear);
  flush = (): Promise<boolean> => {
    if (this.running) return this.running;
    if (this.conflict || this.failedClear) return Promise.resolve(false);
    this.running = (async () => {
      if (!await this.load()) return false;
      while (this.queue.length) {
        const operation = this.queue.shift()!;
        this.publish({ saving: true });
        try {
          const values = operation.kind === 'write' ? { ...this.persisted, ...operation.changes } : undefined;
          const data = await this.request(operation.kind, { revision: this.revision, ...(values ? { values } : {}) });
          this.revision = data.revision;
          this.persisted = { ...this.defaults, ...data.draft?.values };
          this.hasStoredDraft = Boolean(data.draft);
          for (const [key, item] of this.local) if (item.version <= operation.version) this.local.delete(key);
          this.publish({ error: '', ...(operation.kind === 'clear' ? { restored: false } : {}) });
          if (operation.kind === 'clear') { operation.settled = true; operation.finish(true); }
        } catch (error: unknown) {
          this.conflict = (error as { status?: number })?.status === 409;
          if (operation.kind === 'clear') this.holdFailedClear(operation);
          else { this.queue.unshift(operation); this.compactWrites(); }
          this.publish({ saving: false, error: `${operation.kind === 'clear' ? '草稿尚未清除' : '草稿尚未保存'}：${errorText(error)}。文字仍保留在本窗口。` });
          if (operation.kind === 'clear' && !this.failedClear && !this.conflict && this.queue.length) continue;
          return false;
        }
      }
      return true;
    })().finally(() => { this.running = null; this.adoptDefaults(); this.publish({ saving: false }); });
    return this.running;
  };
  clear = (): Promise<boolean> => {
    let finish!: (saved: boolean) => void;
    const completed = new Promise<boolean>((resolve) => { finish = resolve; });
    const operation: Extract<Mutation, { kind: 'clear' }> = { kind: 'clear', version: ++this.version, finish };
    this.failedClear = null;
    this.queue.push(operation);
    this.publish({ saving: !this.conflict });
    void this.flush().then((saved) => { if (!saved) this.holdFailedClear(operation); });
    return completed;
  };
  retry = async () => {
    if (this.running) await this.running;
    if (this.conflict) { this.loaded = false; this.conflict = false; }
    if (this.failedClear) {
      const operation = this.failedClear;
      this.failedClear = null;
      this.queue = this.queue.filter((queued) => queued.version > operation.version);
      this.queue.unshift({ kind: 'clear', version: operation.version, finish: () => {} });
    }
    return this.flush();
  };
}

// The cache outlives task dialogs. Writes remain ordered after unmount, and the
// workspace identity is checked again by the server before every read or write.
export function createTaskDraftStore(transport: Transport = (url, options) => fetch(url, options)) {
  const entries = new Map<string, DraftEntry>();
  return {
    open(workspace: string, scope: TaskDraftScope, defaults: TaskDraftValues = {}) {
      const key = JSON.stringify([workspace, normalizedScope(scope)]);
      let entry = entries.get(key);
      if (!entry) { entry = new DraftEntry(workspace, scope, defaults, transport); entries.set(key, entry); }
      else entry.updateDefaults(defaults);
      return entry;
    },
    async flushAll() {
      let pending = [...entries.values()].filter((entry) => entry.hasPending());
      while (pending.length) {
        const results = await Promise.all(pending.map((entry) => entry.flush()));
        if (results.some((saved) => !saved)) return false;
        pending = [...entries.values()].filter((entry) => entry.hasPending());
      }
      return true;
    },
  };
}
const drafts = createTaskDraftStore();
export const flushAllTaskDrafts = () => drafts.flushAll();
const noSubscription = () => () => {};

export function useTaskDraft(workspace: string | null | undefined, scope: TaskDraftScope | null, defaults: TaskDraftValues = {}) {
  const scopeKey = scope ? JSON.stringify(normalizedScope(scope)) : '';
  const defaultKey = JSON.stringify(defaults);
  const entry = useMemo(() => workspace && scopeKey ? drafts.open(workspace, JSON.parse(scopeKey), JSON.parse(defaultKey)) : null,
    [workspace, scopeKey, defaultKey]);
  const inactive = useMemo<TaskDraftSnapshot>(() => ({ values: JSON.parse(defaultKey), ready: false, loaded: false, saving: false, restored: false, error: '' }), [defaultKey]);
  const snapshot = useSyncExternalStore(entry?.subscribe || noSubscription, entry?.getSnapshot || (() => inactive), () => inactive);
  useEffect(() => { if (entry) void entry.load(); }, [entry]);
  return { ...snapshot,
    setField: entry?.setField || (() => {}), setValues: entry?.setValues || (() => {}),
    clear: entry?.clear || (async () => false), flush: entry?.flush || (async () => false), retry: entry?.retry || (async () => false),
  };
}
