import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, RefreshCw, Save, X } from 'lucide-react';
import { api, ApiError } from './api';
import type { Member, Room, Task, Verification } from './types';
import { useTaskDraft } from './taskDrafts';
import TaskInputPicker from './TaskInputPicker';
import { importTaskInputs, removeTaskInput, restoreTaskInputs, serializeTaskInputs } from './taskInputFiles';
import type { TaskInputItem } from './taskInputFiles';
import TaskTeamFields, { validateTaskTeam } from './TaskTeamFields';
import type { TaskTeamSelection } from './TaskTeamFields';

export interface TaskCreateSeed extends Partial<TaskTeamSelection> {
  title?: string;
  objective?: string;
  requirements?: string;
  sourceSessionId?: string;
  sourceTitle?: string;
  roomId?: string;
}

// Files survive dialog navigation in this window. Only their manifest is saved
// to the workspace; reopening the desktop requires reselecting unimported files.
const inputCache = new Map<string, { manifest: string; items: TaskInputItem[] }>();
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const parseArray = (value: string | undefined): unknown[] => JSON.parse(value || '[]');

function initialFields(seed: TaskCreateSeed, roomId: string) {
  return {
    title: seed.title || '', objective: seed.objective || '', requirements: seed.requirements || '',
    executionMode: seed.executionMode || 'delegated', assigneeId: seed.assigneeId || '',
    reviewerId: seed.reviewerId || '', participantIds: JSON.stringify(seed.participantIds || []),
    roomId: seed.roomId || roomId, verificationCommand: '', sourceSessionId: seed.sourceSessionId || '',
    sourceTitle: seed.sourceTitle || '', preparationTaskId: '', materialManifest: '[]', creationRequestId: '',
  };
}

function verificationFrom(value: string): Verification | null {
  if (!value.trim()) return null;
  const parts: unknown = JSON.parse(value);
  if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== 'string') || !parts[0].trim()) {
    throw new Error('请填写检查程序；每行一个参数，或在高级配置中填写字符串数组');
  }
  if (parts[0].length > 1000 || parts.length > 41 || parts.slice(1).some((part) => part.length > 2000)) {
    throw new Error('检查程序最多 1000 字，最多 40 个参数，每个参数不超过 2000 字');
  }
  return { executable: parts[0].trim(), args: parts.slice(1) };
}

export default function TaskCreateDialog({ workspaceRoot, workspacesPath, members, rooms, seed, defaultRoomId,
  onClose, onCreated, onOpenMembers, onBusyChange }: {
  workspaceRoot: string; workspacesPath: string; members: Member[]; rooms: Room[];
  seed: TaskCreateSeed; defaultRoomId: string;
  onClose: () => void; onCreated: (task: Task, warning?: string) => Promise<void>;
  onOpenMembers: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const defaults = useRef(initialFields(seed, defaultRoomId)).current;
  const scope = { kind: 'new-task' as const, contextId: seed.sourceSessionId || undefined };
  const draft = useTaskDraft(workspaceRoot, scope, defaults);
  const values = { ...defaults, ...draft.values };
  const cacheKey = JSON.stringify([workspaceRoot, scope.contextId || '']);
  const [items, setItems] = useState<TaskInputItem[]>([]);
  const itemsRef = useRef(items);
  const [inputsReady, setInputsReady] = useState(false);
  const hydratedManifest = useRef<string | null>(null);
  const [preparedTask, setPreparedTask] = useState<Task | null>(null);
  const preparedTaskRef = useRef<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [taskLoadAttempt, setTaskLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const preparedId = preparedTask?.id || values.preparationTaskId;
  const activeRooms = rooms.filter((room) => room.kind === 'team' && !room.archivedAt);
  const team: TaskTeamSelection = {
    executionMode: values.executionMode === 'direct' ? 'direct' : 'delegated',
    assigneeId: values.assigneeId, reviewerId: values.reviewerId,
    participantIds: (() => { try { return parseArray(values.participantIds).filter((id): id is string => typeof id === 'string'); } catch { return []; } })(),
  };
  const completed = preparedTask && (preparedTask.status !== 'backlog' || Boolean(preparedTask.startedAt));
  const creationPending = Boolean(values.creationRequestId && !preparedId);
  const frozen = busy || !draft.loaded || !inputsReady || Boolean(preparedId) || creationPending;
  const ready = draft.loaded && inputsReady && !loadingTask && (!values.preparationTaskId || Boolean(preparedTask));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!draft.loaded || draft.error || (inputsReady && hydratedManifest.current === values.materialManifest)) return;
    try {
      const cached = inputCache.get(cacheKey);
      const manifest = values.materialManifest || '[]';
      const restored = cached?.manifest === manifest ? cached.items : restoreTaskInputs(parseArray(manifest));
      itemsRef.current = restored;
      hydratedManifest.current = manifest;
      setItems(restored);
      setInputsReady(true);
    } catch { setError('材料草稿无法读取，请保留当前窗口并重试恢复'); }
  }, [draft.loaded, draft.error, inputsReady, cacheKey, values.materialManifest]);
  useEffect(() => {
    if (!draft.loaded || !values.preparationTaskId || preparedTaskRef.current?.id === values.preparationTaskId) return;
    let current = true;
    setLoadingTask(true);
    setError('');
    void api.getBootstrap(true).then((data) => {
      if (!current) return;
      const task = data.tasks.find((item) => item.id === values.preparationTaskId);
      if (!task) throw new Error('上次准备的待办已不存在。请先核对任务列表，再放弃此草稿重新准备');
      preparedTaskRef.current = task;
      setPreparedTask(task);
    }).catch((reason) => { if (current) setError(messageOf(reason)); })
      .finally(() => { if (current) setLoadingTask(false); });
    return () => { current = false; };
  }, [draft.loaded, values.preparationTaskId, taskLoadAttempt]);

  const updateItems = (next: TaskInputItem[]) => {
    itemsRef.current = next;
    const manifest = JSON.stringify(serializeTaskInputs(next));
    hydratedManifest.current = manifest;
    inputCache.set(cacheKey, { manifest, items: next });
    draft.setField('materialManifest', manifest);
    if (mounted.current) setItems(next);
  };
  const changeTeam = (patch: Partial<TaskTeamSelection>) => {
    const next = { ...team, ...patch };
    draft.setValues({ ...values, executionMode: next.executionMode, assigneeId: next.assigneeId,
      reviewerId: next.reviewerId, participantIds: JSON.stringify(next.participantIds) });
  };
  const leave = async (next = onClose) => {
    if (actionLock.current) return;
    setOperation(true);
    setPhase('正在保存填写草稿');
    try {
      if (!await draft.flush()) { setError('草稿尚未保存到工作区，请重试保存后再离开'); return; }
      if (mounted.current) next();
    } finally { setOperation(false); }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void leave();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });

  const setOperation = (value: boolean) => {
    actionLock.current = value;
    onBusyChange(value);
    if (mounted.current) setBusy(value);
  };
  const finish = async (task: Task) => {
    const cleared = await draft.clear();
    if (cleared) inputCache.delete(cacheKey);
    await onCreated(task, cleared ? undefined : '任务已保存，但填写草稿清理失败；再次打开新建时可核对并清理原记录');
  };
  const prepare = async (start: boolean, onlyId?: string) => {
    if (actionLock.current || !ready || completed) return;
    if (!preparedId && !form.current?.reportValidity()) return;
    const teamError = validateTaskTeam(preparedTask ? { executionMode: preparedTask.executionMode || 'direct',
      assigneeId: preparedTask.assigneeId, reviewerId: preparedTask.reviewerId || '', participantIds: preparedTask.participantIds || [] } : team, members);
    if (teamError && !creationPending) { setError(teamError); return; }
    if (!preparedId && !creationPending && !activeRooms.some((room) => room.id === values.roomId)) {
      setError('原频道已不可用，请重新选择所属频道'); return;
    }
    let verification: Verification | null;
    const requirements = values.requirements.split('\n').map((line) => line.trim()).filter(Boolean);
    if (requirements.length > 30 || requirements.some((line) => line.length > 1000)) {
      setError('完成标准最多 30 项，每项不超过 1000 字'); return;
    }
    try { verification = verificationFrom(values.verificationCommand); }
    catch (reason) { setError(reason instanceof SyntaxError ? '自动检查高级配置不是合法 JSON，请修正后保存' : messageOf(reason)); return; }
    setOperation(true);
    setError(''); setNotice(''); setPhase('正在保存准备信息');
    try {
      if (!await draft.flush()) throw new Error('准备信息尚未保存，请先重试草稿保存');
      if (!mounted.current) return;
      let task = preparedTaskRef.current;
      if (!task && values.preparationTaskId) throw new Error('请先恢复上次的待办记录，避免重复创建');
      if (!task) {
        const creationRequestId = values.creationRequestId || crypto.randomUUID();
        draft.setField('creationRequestId', creationRequestId);
        if (!await draft.flush()) throw new Error('创建请求尚未保存，请重试草稿保存');
        if (!mounted.current) return;
        try { task = await api.createTask({ title: values.title.trim(), objective: values.objective.trim(), ...team,
          participantIds: team.executionMode === 'delegated' ? team.participantIds : [],
          reviewerId: team.reviewerId || null, requirements, creationRequestId,
          verification, start: false, sourceSessionId: values.sourceSessionId || undefined, roomId: values.roomId }); }
        catch (reason) {
          if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 409) {
            draft.setField('creationRequestId', '');
          }
          throw reason;
        }
        preparedTaskRef.current = task;
        if (mounted.current) setPreparedTask(task);
        draft.setField('preparationTaskId', task.id);
        if (!await draft.flush()) throw new Error('待办已创建，关联草稿尚未保存；请重试，系统会继续使用这项待办');
      }
      if (!mounted.current) return;
      if (task.status !== 'backlog' || task.startedAt) {
        setNotice('这项任务已开始或已结束，请进入已有任务查看。');
        return;
      }
      setPhase('正在导入并核对材料');
      const result = await importTaskInputs(task.id, itemsRef.current, updateItems, { transport: api, onlyId,
        isCurrent: () => mounted.current });
      if (!await draft.flush()) throw new Error('材料准备记录尚未保存；任务保持待办，请重试保存');
      if (!mounted.current) return;
      if (onlyId) {
        if (result.error) throw new Error(result.error);
        setNotice('材料已核对。完成全部准备后，再选择保存待办或开始执行。');
        return;
      }
      if (!result.complete) throw new Error(result.error || '仍有材料未导入。待办和已导入文件已保留，请重试或重新选择缺少的文件');
      if (start) {
        setPhase('正在启动任务');
        task = await api.startPreparedTask(task.id);
        preparedTaskRef.current = task;
        setPreparedTask(task);
      }
      await finish(task);
    } catch (reason) {
      if (mounted.current) setError(messageOf(reason));
    } finally { setOperation(false); }
  };
  const removeImported = async (id: string) => {
    if (actionLock.current || !preparedId) return;
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item) return;
    setOperation(true); setError(''); setPhase('正在移除材料副本');
    try {
      await removeTaskInput(preparedId, item, api);
      updateItems(itemsRef.current.filter((entry) => entry.id !== id));
      if (!await draft.flush()) throw new Error('材料副本已移除，草稿记录尚未保存，请重试保存');
    } catch (reason) { setError(messageOf(reason)); }
    finally { setOperation(false); }
  };
  const discard = async () => {
    if (actionLock.current) return;
    setOperation(true);
    try {
      if (!await draft.clear()) return;
      inputCache.delete(cacheKey);
      onClose();
    } finally { setOperation(false); }
  };

  let commandParts: string[] = [];
  try {
    const parsed = JSON.parse(values.verificationCommand || '[]');
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) commandParts = parsed;
  } catch { /* Keep malformed advanced input visible and recoverable. */ }
  const updateCommand = (program: string, args: string[]) => draft.setField('verificationCommand', JSON.stringify([program, ...args]));

  return <div className="modal-overlay" onClick={() => { void leave(); }}>
    <div className="modal-content modal-lg task-create-dialog" data-testid="task-create-dialog" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <span className="modal-title">{values.sourceSessionId ? '准备独立接力任务' : '准备新任务'}</span>
        <button type="button" className="btn btn-sm btn-secondary btn-icon-only" disabled={busy}
          aria-label="保存草稿并关闭" onClick={() => { void leave(); }}><X size={14} /></button>
      </div>
      <form ref={form} data-testid="task-create-form" onSubmit={(event) => { event.preventDefault(); void prepare(false); }}>
        <div className="modal-body">
          <div className="task-preparation-intro">
            <strong>交代目标、安排团队、提供材料，然后开始。</strong>
            <span>填写内容会保存在当前工作区；关闭后可以继续填写。保存待办不会启动成员。</span>
          </div>
          {!ready && <p role="status">正在恢复准备信息…</p>}
          {draft.restored && <div className="draft-status" role="status"><Save size={14} />已恢复上次未完成的填写内容</div>}
          {draft.error && <div className="error-banner" role="alert"><AlertCircle size={14} /><span>{draft.error}</span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { void draft.retry(); }}><RefreshCw size={13} />重试保存</button></div>}
          {error && <div className="error-banner" role="alert" data-testid="task-create-error"><AlertCircle size={14} /><span>{error}</span>
            {values.preparationTaskId && !preparedTask && <button type="button" className="btn btn-sm btn-secondary" disabled={loadingTask || busy}
              onClick={() => setTaskLoadAttempt((attempt) => attempt + 1)}>重新恢复待办</button>}</div>}
          {notice && <p className="draft-status" role="status"><Check size={14} />{notice}</p>}
          {creationPending && <p className="task-prepared-note" role="status">正在确认上次创建结果。重试会恢复同一个待办，目标与分工暂时保留。</p>}
          {preparedId && <div className="task-prepared-note" role="status">
            <strong>{completed ? '这项任务已经离开待办状态' : '待办已保存，继续准备材料即可'}</strong>
            <span>{completed ? '请进入已有任务查看当前进度。' : '目标与分工已固定；重试会使用这项待办和已导入的材料。'}</span>
            {preparedTask && <span className="mono-path">任务目录：{preparedTask.workspace}</span>}
            {preparedTask && <button type="button" className="btn btn-sm btn-secondary" disabled={busy}
              onClick={() => { void leave(() => { void onCreated(preparedTask); }); }}>查看已有待办</button>}
          </div>}
          <fieldset className="task-preparation-fields" disabled={frozen}>
            {values.sourceSessionId && <div className="form-group"><label className="form-label">接力来源</label>
              <span>{values.sourceTitle}</span><small className="text-muted">独立任务 · 原会话保留写入权</small></div>}
            <div className="form-group"><label className="form-label" htmlFor="task-create-title">任务标题</label>
              <input id="task-create-title" data-testid="task-create-title" className="form-input" required maxLength={120}
                placeholder="简明描述任务目标" value={values.title} onChange={(event) => draft.setField('title', event.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="task-create-objective">任务目标</label>
              <textarea id="task-create-objective" data-testid="task-create-objective" className="form-textarea" required rows={4} maxLength={12000}
                placeholder="说明要解决的问题、期望得到的成果与需要遵守的约束" value={values.objective}
                onChange={(event) => draft.setField('objective', event.target.value)} /></div>
            <div className="form-group"><label className="form-label" htmlFor="task-room">所属频道</label>
              <select id="task-room" className="form-select" value={values.roomId} onChange={(event) => draft.setField('roomId', event.target.value)}>
                {!activeRooms.some((room) => room.id === values.roomId) && <option value={values.roomId} disabled>原频道不可用，请重新选择</option>}
                {activeRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
              </select></div>
            <TaskTeamFields members={members} value={team} onChange={changeTeam} disabled={frozen}
              onOpenMembers={() => { void leave(onOpenMembers); }} />
            <div className="form-group"><label className="form-label" htmlFor="task-create-requirements">完成标准（每行一项）</label>
              <textarea id="task-create-requirements" data-testid="task-create-requirements" className="form-textarea" rows={3} maxLength={12000}
                placeholder={'例如：列出结论与引用来源\n保留原始材料\n说明尚未解决的问题'} value={values.requirements}
                onChange={(event) => draft.setField('requirements', event.target.value)} /></div>
            <fieldset className="task-verification-choice"><legend className="form-label">怎样检查成果</legend>
              <label><input type="radio" name="verification-mode" checked={!values.verificationCommand}
                onChange={() => draft.setField('verificationCommand', '')} />人工核对完成标准</label>
              <label><input type="radio" name="verification-mode" checked={Boolean(values.verificationCommand)}
                onChange={() => updateCommand('', [])} />运行自动检查</label>
            </fieldset>
            {!values.verificationCommand ? <p className="form-hint">结果完成后由你核对并验收；此选择不会产生自动检查通过的证据。</p>
              : <div className="task-verification-fields">
                <div className="form-group"><label className="form-label" htmlFor="task-check-program">检查程序</label>
                  <input id="task-check-program" className="form-input form-input-mono" placeholder="例如 node 或 npm" value={commandParts[0] || ''}
                    onChange={(event) => updateCommand(event.target.value, commandParts.slice(1))} /></div>
                <div className="form-group"><label className="form-label" htmlFor="task-check-args">程序参数（每行一个）</label>
                  <textarea id="task-check-args" className="form-textarea form-input-mono" rows={2} placeholder="例如 --test"
                    value={commandParts.slice(1).join('\n')} onChange={(event) => updateCommand(commandParts[0] || '', event.target.value.split('\n'))} /></div>
                <details><summary>高级配置：参数数组</summary><label className="form-label" htmlFor="task-check-json">程序及参数的 JSON 数组</label>
                  <input id="task-check-json" data-testid="task-create-verification" className="form-input form-input-mono" value={values.verificationCommand}
                    onChange={(event) => draft.setField('verificationCommand', event.target.value)} placeholder='["node", "--test"]' /></details>
              </div>}
          </fieldset>
          <TaskInputPicker items={items} onChange={updateItems} disabled={busy || !ready || Boolean(completed)}
            onRetry={(id) => { void prepare(false, id); }} onRemoveImported={(id) => { void removeImported(id); }} />
          <p className="form-hint">任务会在 {preparedTask ? '上方所示的独立任务目录' : workspacesPath} 内执行。首次启动后材料固定，不能再增删。</p>
          <div className="draft-controls">
            <span className="draft-status" role="status">{busy ? phase : !draft.ready ? '正在恢复填写草稿…' : draft.saving ? '正在保存填写草稿…' : draft.error ? '草稿尚未保存' : '填写草稿已保存到本工作区'}</span>
            {!discarding ? <button type="button" className="btn btn-sm btn-secondary" data-testid="task-draft-discard" disabled={busy || !draft.ready}
              onClick={() => setDiscarding(true)}>放弃草稿</button>
              : <div className="draft-discard"><span>清除填写记录？{preparedId && '已创建的待办和材料副本会保留。'}</span>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => { void discard(); }}>确认放弃草稿</button>
                <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setDiscarding(false)}>继续填写</button></div>}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { void leave(); }}>稍后继续</button>
          <button type="submit" className="btn btn-secondary" data-testid="task-create-submit" disabled={busy || !ready || Boolean(completed)}>
            {busy ? phase : '保存待办'}</button>
          <button type="button" className="btn btn-primary" data-testid="task-create-start" disabled={busy || !ready || Boolean(completed)}
            onClick={() => { void prepare(true); }}>准备完成并开始</button>
        </div>
      </form>
    </div>
  </div>;
}
