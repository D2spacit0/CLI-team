import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  MessagesSquare,
  CheckSquare,
  Users,
  FolderArchive,
  Settings as SettingsIcon,
  Play,
  Square,
  RotateCcw,
  Check,
  X,
  Plus,
  Search,
  Terminal,
  AlertCircle,
  ShieldCheck,
  Send,
  Pause,
  RefreshCw,
  ExternalLink,
  Menu,
  FileText,
  UserCheck,
  Cpu,
  Monitor,
  Archive,
  ArchiveRestore,
  BookOpen,
  Clock3,
  Activity,
} from 'lucide-react';
import type {
  Bootstrap,
  Room,
  Member,
  Task,
  TaskProgress,
  Run,
  RunDetails,
  Artifact,
  Settings,
} from './types';
import { api, subscribeEvents } from './api';
import { deliverRoomMessage } from './workbench/rooms/messageDelivery';
import { useRoomHistory } from './workbench/useRoomHistory';
import ExternalSessions from './ExternalSessions';
import TaskMaterials from './TaskMaterials';
import ArtifactPreview from './ArtifactPreview';
import ArtifactDownload from './ArtifactDownload';
import TaskAssignment from './TaskAssignment';
import ActionConfirmDialog from './ActionConfirmDialog';
import RunDiagnostics from './RunDiagnostics';
import MemberConnection from './MemberConnection';
import ModelChoice from './ModelChoice';
import DesktopSettings from './DesktopSettings';
import RuntimeSettingsForm from './RuntimeSettingsForm';
import DiscussionDialog from './DiscussionDialog';
import TaskCoordination from './TaskCoordination';
import TaskCreateDialog from './TaskCreateDialog';
import type { TaskCreateSeed } from './TaskCreateDialog';
import { useTaskDraft, flushAllTaskDrafts } from './taskDrafts';
import { isMemberRunnable } from './memberAvailability';
import RoomWorkbench from './workbench/RoomWorkbench';
import { acceptanceIssue, messageAudience, parseRecipientIds, runStatusLabels, stageLabels } from './workbench/roomState';
import { WorkbenchNav, type WorkbenchTab } from './workbench/navigation/WorkbenchNav';
import { AttentionView } from './workbench/attention/AttentionView';
import { FixtureWorkbench } from './workbench/fixtures/FixtureWorkbench';
import { useWorkbenchRoute } from './workbench/navigation/useWorkbenchRoute';
import ManagedRequestDialog from './ManagedRequestDialog';
import ManagedTeamSettings from './ManagedTeamSettings';

type NavTab = WorkbenchTab;
type TaskBusySource = 'materials' | 'assignment' | 'coordination' | 'start' | 'accept' | 'revise' | 'cancel' | 'archive' | 'refresh';
type TaskBusyFlags = Partial<Record<TaskBusySource, boolean>>;
const hasTaskBusy = (flags?: TaskBusyFlags) => Object.values(flags || {}).some(Boolean);
const needsAssistanceAnswer = (task: Task, progress: TaskProgress | null) => task.status === 'blocked' && !task.pendingFeedback
  && Boolean(progress?.coordination?.planId && progress.assistance?.some((help) => help.taskId === task.id
    && help.planId === progress.coordination?.planId && help.status === 'blocked' && !help.interrupted));
const taskStatusNames: Record<Task['status'], string> = {
  backlog: '待处理', running: '执行中', review: '待验收', done: '已完成', blocked: '需处理', cancelled: '已取消',
};
const canPreview = (artifact: Artifact) => /\.(txt|md|json|csv|log)$/i.test(artifact.name);
const runStageName = (stage: string) => stageLabels[stage] || stage;

export default function App() {
  const { route, lastHash, navigate, closeTask, openTask } = useWorkbenchRoute(
    new URLSearchParams(window.location.search).get('room')
  );

  // 核心数据状态
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>(route.view || 'rooms');
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    () => route.roomId || new URLSearchParams(window.location.search).get('room')
  );

  // 双向路由同步
  useEffect(() => {
    if (route.view && route.view !== activeTab) {
      setActiveModal((current) => current && ['createTask', 'createRoom', 'createMeeting', 'managedRequest'].includes(current) ? null : current);
      setActiveTab(route.view);
    }
  }, [route.view, activeTab]);

  useEffect(() => {
    if (route.roomId && route.roomId !== activeRoomId) {
      setActiveRoomId(route.roomId);
    }
  }, [route.roomId, activeRoomId]);

  const handleTabChange = useCallback((tab: WorkbenchTab) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
    navigate(tab, { roomId: tab === 'rooms' ? activeRoomId : null, replace: true });
  }, [activeRoomId, navigate]);

  const roomHistory = useRoomHistory(bootstrap?.workspace.root, activeRoomId);
  const { messages, refresh: loadRoomMessages } = roomHistory;
  const [sseStatus, setSseStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connecting');
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const appLayout = useRef<HTMLDivElement>(null);
  const [desktopLeaving, setDesktopLeaving] = useState(false);

  // 讨论消息发送状态
  const roomDraft = useTaskDraft(bootstrap?.workspace.root, activeRoomId && bootstrap?.rooms.some((room) => room.id === activeRoomId)
    ? { kind: 'room-message', roomId: activeRoomId } : null, { body: '', recipientIds: '[]', taskId: '' });
  const messageBody = roomDraft.values.body || '';
  const selectedRecipientIds = parseRecipientIds(roomDraft.values.recipientIds);
  const messageTaskId = roomDraft.values.taskId || '';
  const [analysisRooms, setAnalysisRooms] = useState<Record<string, boolean>>({});
  const analysisOnly = Boolean(activeRoomId && analysisRooms[activeRoomId]);
  const [sendingRooms, setSendingRooms] = useState<Record<string, boolean>>({});
  const sendingMessageRef = useRef(new Set<string>());
  const [messageErrors, setMessageErrors] = useState<Record<string, string>>({});

  // 模态弹窗状态
  const [activeModal, setActiveModal] = useState<
    | null
    | 'createRoom'
    | 'createMeeting'
    | 'createTask'
    | 'managedRequest'
    | 'taskDetail'
    | 'memberEdit'
    | 'memberCreate'
    | 'runDetail'
    | 'artifactPreview'
  >(null);

  // 选中的对象详情状态
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDockElement, setTaskDockElement] = useState<HTMLDivElement | null>(null);
  const [taskSection, setTaskSection] = useState<{ taskId: string; section: string } | null>(null);
  const currentView = useRef({ modal: activeModal, taskId: selectedTaskId });
  currentView.current = { modal: activeModal, taskId: selectedTaskId };
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const [taskProgressLoading, setTaskProgressLoading] = useState(false);
  const [taskProgressError, setTaskProgressError] = useState('');
  const taskProgressSequence = useRef(0);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunData, setSelectedRunData] = useState<RunDetails | null>(null);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [savedMemberSnapshot, setSavedMemberSnapshot] = useState<Member | null>(null);
  const [memberSaving, setMemberSaving] = useState(false);
  const [memberError, setMemberError] = useState('');
  const [memberNotice, setMemberNotice] = useState('');
  const [memberPending, setMemberPending] = useState<Record<string, boolean>>({});
  const memberSaveLock = useRef(false);
  const memberFormInitial = useRef<string>('');
  const [discardMemberOpen, setDiscardMemberOpen] = useState(false);
  const memberActionLocks = useRef(new Set<string>());
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [previewReturnTask, setPreviewReturnTask] = useState(false);
  const [runReturnTask, setRunReturnTask] = useState(false);
  const lastTaskInput = useRef<{ taskId: string; input: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const taskViewRestore = useRef<{
    taskId: string; planId?: string; artifactRevision?: string; scrollTop: number;
    selector?: string; selectionStart?: number | null; selectionEnd?: number | null;
  } | null>(null);
  const [runLogError, setRunLogError] = useState('');
  const runDetailsSequence = useRef(0);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveActionLock = useRef(false);
  const lastRouteTaskId = useRef(route.taskId);
  useEffect(() => {
    const taskId = route.taskId;
    if (!taskId) {
      setActiveModal(current => current && ['taskDetail', 'runDetail', 'artifactPreview'].includes(current) ? null : current);
      setSelectedTaskId(null);
      lastRouteTaskId.current = null;
      return;
    }
    if (lastRouteTaskId.current === taskId && lastHash.current !== null) return;
    lastRouteTaskId.current = taskId;
    setSelectedTaskId(taskId);
    setActiveModal('taskDetail');
  }, [route.taskId, lastHash.current]);

  useEffect(() => {
    const taskId = route.taskId;
    if (!taskId || !bootstrap || bootstrap.tasks.some((task) => task.id === taskId)) return;
    setError('该任务未在当前工作区列表中，请到归档记录中查找。');
    setActiveModal(current => current === 'taskDetail' ? null : current);
    setSelectedTaskId(null);
  }, [route.taskId, bootstrap]);

  // 破坏性操作确认弹窗数据
  const [confirmConfig, setConfirmConfig] = useState<{
    kind: 'task' | 'run'; id: string;
    title: string;
    message: string;
    confirmText: string;
    returnText: string;
    taskId?: string | null;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);
  const [confirmError, setConfirmError] = useState('');
  const confirmActionLock = useRef(false);

  const discussionBusy = useRef(false);

  // 任务创建表单状态
  const [taskCreateSeed, setTaskCreateSeed] = useState<TaskCreateSeed>({ executionMode: 'delegated' });
  const [returnToTaskCreation, setReturnToTaskCreation] = useState(false);
  const [managedRequestRoomId, setManagedRequestRoomId] = useState('team');
  const [returnToManagedRequest, setReturnToManagedRequest] = useState<string | null>(null);
  const taskCreateBusy = useRef(false);
  const [taskBusy, setTaskBusy] = useState<Record<string, TaskBusyFlags>>({});
  const taskBusyRef = useRef<Record<string, TaskBusyFlags>>({});
  const [taskNotices, setTaskNotices] = useState<Record<string, { tone: 'error' | 'success' | 'warning'; text: string; cleanup?: () => Promise<boolean> }>>({});
  const [taskNeedsRefresh, setTaskNeedsRefresh] = useState<Record<string, boolean>>({});
  const taskNeedsRefreshRef = useRef<Record<string, boolean>>({});
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, { ready: boolean; dirty: boolean }>>({});
  const reportTaskBusy = useCallback((taskId: string, source: TaskBusySource, busy: boolean) => {
    const current = taskBusyRef.current[taskId] || {};
    if (Boolean(current[source]) === busy) return;
    const flags = { ...current };
    if (busy) flags[source] = true;
    else delete flags[source];
    const next = { ...taskBusyRef.current };
    if (hasTaskBusy(flags)) next[taskId] = flags;
    else delete next[taskId];
    taskBusyRef.current = next;
    setTaskBusy(next);
  }, []);
  const isTaskBusy = (taskId?: string | null) => Boolean(taskId && (hasTaskBusy(taskBusyRef.current[taskId]) || taskNeedsRefreshRef.current[taskId]));
  const beginTaskOperation = (taskId: string, source: TaskBusySource) => {
    if (isTaskBusy(taskId)) return false;
    reportTaskBusy(taskId, source, true);
    return true;
  };
  const reportMaterialsBusy = useCallback((busy: boolean) => {
    if (selectedTaskId) reportTaskBusy(selectedTaskId, 'materials', busy);
  }, [selectedTaskId, reportTaskBusy]);
  const reportAssignmentBusy = useCallback((busy: boolean) => {
    if (selectedTaskId) reportTaskBusy(selectedTaskId, 'assignment', busy);
  }, [selectedTaskId, reportTaskBusy]);
  const reportAssignmentDraft = useCallback((ready: boolean, dirty: boolean) => {
    if (!selectedTaskId) return;
    setAssignmentDrafts(current => current[selectedTaskId]?.ready === ready && current[selectedTaskId]?.dirty === dirty
      ? current : { ...current, [selectedTaskId]: { ready, dirty } });
  }, [selectedTaskId]);
  const reportCoordinationBusy = useCallback((busy: boolean) => {
    if (selectedTaskId) reportTaskBusy(selectedTaskId, 'coordination', busy);
  }, [selectedTaskId, reportTaskBusy]);
  const isCurrentTaskDetail = (taskId: string) => currentView.current.modal === 'taskDetail' && currentView.current.taskId === taskId;
  // Text drafts follow the task and delivery context; acceptance consent stays transient.
  const draftTask = bootstrap?.tasks.find((task) => task.id === selectedTaskId);
  const implementationContexts = useRef(new Map<string, string>());
  const contextKey = JSON.stringify([bootstrap?.workspace.root, selectedTaskId]);
  const observedImplementation = [...(bootstrap?.runs || []), ...(taskProgress?.taskId === selectedTaskId ? taskProgress.runs : [])]
    .filter((run) => run.taskId === selectedTaskId && run.stage === 'implement')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id;
  if (observedImplementation) implementationContexts.current.set(contextKey, observedImplementation);
  const latestImplementation = implementationContexts.current.get(contextKey) || 'initial';
  const draftContextReady = draftTask && (draftTask.coordination?.planId || implementationContexts.current.has(contextKey)
    || (draftTask.status === 'backlog' && !draftTask.startedAt) || taskProgress?.taskId === selectedTaskId);
  const revisionDraft = useTaskDraft(bootstrap?.workspace.root || '', draftTask && draftContextReady ? {
    kind: 'revision', taskId: draftTask.id, planId: draftTask.coordination?.planId,
    contextId: draftTask.coordination?.planId ? undefined : latestImplementation,
  } : null, { feedback: '' });
  const acceptanceDraft = useTaskDraft(bootstrap?.workspace.root || '', draftTask && draftContextReady ? {
    kind: 'acceptance', taskId: draftTask.id, planId: draftTask.coordination?.planId,
    contextId: draftTask.artifactRevision || (draftTask.coordination?.planId ? 'initial' : latestImplementation),
  } : null, { note: '' });
  const acceptNote = acceptanceDraft.values.note || '';
  const reviseFeedback = revisionDraft.values.feedback || '';
  const setAcceptNote = (value: string) => acceptanceDraft.setField('note', value);
  const setReviseFeedback = (value: string) => revisionDraft.setField('feedback', value);
  const [acknowledgeMissingGate, setAcknowledgeMissingGate] = useState(false);
  const [showReviseInput, setShowReviseInput] = useState(false);
  useEffect(() => {
    setAcknowledgeMissingGate(false);
    setShowReviseInput(false);
  }, [selectedTaskId, activeModal, draftTask?.coordination?.planId, draftTask?.artifactRevision]);
  useEffect(() => {
    const desktop = window.cliTeamDesktop;
    if (!desktop) return;
    let leaving = false;
    let previousFocus: HTMLElement | null = null;
    const resume = () => {
      leaving = false;
      if (appLayout.current) appLayout.current.inert = false;
      setDesktopLeaving(false);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      previousFocus = null;
    };
    const blockInput = (event: Event) => {
      if (!leaving) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ['keydown', 'beforeinput', 'input', 'paste', 'drop', 'click', 'submit'];
    for (const event of events) window.addEventListener(event, blockInput, true);
    const unsubscribe = desktop.onBeforeLeave(async () => {
      if (taskCreateBusy.current || sendingMessageRef.current.size || Object.values(taskBusyRef.current).some(hasTaskBusy)
          || unsavedSettings.current || unsavedTeam.current || pauseLock.current || discussionBusy.current
          || memberSaveLock.current || memberActionLocks.current.size || confirmActionLock.current
          || discardMemberOpen) return false;
      // Freeze synchronously so later keystrokes cannot arrive after the save receipt.
      leaving = true;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (appLayout.current) appLayout.current.inert = true;
      setDesktopLeaving(true);
      return flushAllTaskDrafts();
    }, resume);
    return () => {
      unsubscribe();
      for (const event of events) window.removeEventListener(event, blockInput, true);
      if (appLayout.current) appLayout.current.inert = false;
    };
  }, []);

  // 成员创建/编辑表单状态
  const [memberForm, setMemberForm] = useState<{
    skills: string;
    name: string;
    handle: string;
    provider: Member['provider'];
    role: Member['role'];
    model: string;
    executable: string;
    prefixArgs: string;
    customArgs: string;
    inputMode: 'argument' | 'stdin';
    enabled: boolean;
    permission: 'plan' | 'edit';
    dshConfigProfile: NonNullable<Member['dshConfigProfile']>;
  }>({
    skills: '',
    name: '',
    handle: '',
    provider: 'antigravity',
    role: 'builder',
    model: '',
    executable: '',
    prefixArgs: '',
    customArgs: '',
    inputMode: 'argument',
    enabled: true,
    permission: 'edit',
    dshConfigProfile: 'auto',
  });
  const memberFormDirty = activeModal === 'memberEdit' || activeModal === 'memberCreate'
    ? JSON.stringify(memberForm) !== memberFormInitial.current
    : false;

  const unsavedSettings = useRef(false);
  const unsavedTeam = useRef(false);
  const [pausePending, setPausePending] = useState(false);
  const pauseLock = useRef(false);

  const refreshDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapSequence = useRef(0);

  // 加载初始 Bootstrap
  const loadBootstrap = useCallback(async () => {
    const sequence = ++bootstrapSequence.current;
    try {
      const data = await api.getBootstrap(activeTabRef.current === 'archive');
      if (route.taskId && !data.tasks.some((task) => task.id === route.taskId)) {
        const archived = await api.getBootstrap(true);
        if (sequence !== bootstrapSequence.current) return;
        if (archived.tasks.some((task) => task.id === route.taskId)) {
          setBootstrap(archived);
          setActiveRoomId((curr) => curr && archived.rooms.some((room) => room.id === curr) ? curr : null);
          setError(null);
          return;
        }
      }
      if (sequence !== bootstrapSequence.current) return;
      setBootstrap(data);
      // 如果当前没有选中的房间且有房间，默认选择第一个
      setActiveRoomId((curr) => {
        if (curr && data.rooms.some((r) => r.id === curr)) return curr;
        return data.tasks.find((task) => !task.archivedAt && !['done', 'cancelled'].includes(task.status))?.roomId ||
          data.rooms.find((room) => !room.archivedAt)?.id || null;
      });
      setError(null);
    } catch (err: unknown) {
      if (sequence === bootstrapSequence.current) setError(err instanceof Error ? err.message : '获取工作区数据失败');
    } finally {
      if (sequence === bootstrapSequence.current) setLoading(false);
    }
  }, [activeTab, route.taskId]);

  useEffect(() => {
    if (!activeRoomId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', activeRoomId);
    if (url.pathname + url.search + url.hash !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, '', url);
    }
  }, [activeRoomId]);

  // 初始加载
  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!taskSection || activeModal !== 'taskDetail' || taskSection.taskId !== selectedTaskId) return;
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>('[data-task-section="' + CSS.escape(taskSection.section) + '"]');
      if (element) { element.scrollIntoView({ block: 'start' }); setTaskSection(null); }
    });
    return () => cancelAnimationFrame(frame);
  }, [taskSection, activeModal, selectedTaskId, taskDockElement, taskProgress?.taskId]);

  const loadTaskProgress = useCallback(async () => {
    const target = activeModal === 'taskDetail' ? selectedTaskId : null;
    const currentTarget = () => currentView.current.modal === 'taskDetail' ? currentView.current.taskId : null;
    if (currentTarget() !== target) return;
    const sequence = ++taskProgressSequence.current;
    if (!target) {
      setTaskProgress(null); setTaskProgressError(''); setTaskProgressLoading(false); return;
    }
    setTaskProgressLoading(true);
    try {
      const data = await api.taskProgress(target);
      if (sequence === taskProgressSequence.current && currentTarget() === target) { setTaskProgress(data); setTaskProgressError(''); }
    } catch (reason) {
      if (sequence === taskProgressSequence.current && currentTarget() === target) setTaskProgressError(reason instanceof Error ? reason.message : '任务进度读取失败');
    } finally {
      if (sequence === taskProgressSequence.current && currentTarget() === target) setTaskProgressLoading(false);
    }
  }, [selectedTaskId, activeModal]);
  useEffect(() => {
    void loadTaskProgress();
    return () => { taskProgressSequence.current++; };
  }, [loadTaskProgress, bootstrap]);
  const refreshTask = async () => { await Promise.all([loadBootstrap(), loadTaskProgress()]); };
  useEffect(() => {
    const saved = taskViewRestore.current;
    if (!saved || activeModal !== 'taskDetail' || selectedTaskId !== saved.taskId || taskProgressLoading) return;
    if (saved.planId !== draftTask?.coordination?.planId || saved.artifactRevision !== draftTask?.artifactRevision) {
      taskViewRestore.current = null; return;
    }
    const body = document.querySelector<HTMLElement>('[data-task-detail] .modal-body');
    if (!body) return;
    let observer: MutationObserver | undefined;
    const restore = () => {
      body.scrollTop = saved.scrollTop;
      const input = saved.selector ? body.querySelector<HTMLInputElement | HTMLTextAreaElement>(saved.selector) : null;
      if (saved.selector && (!input || input.disabled)) return;
      if (input) {
        input.focus({ preventScroll: true });
        if (saved.selectionStart != null && saved.selectionEnd != null) input.setSelectionRange(saved.selectionStart, saved.selectionEnd);
      }
      taskViewRestore.current = null;
      observer?.disconnect();
    };
    observer = new MutationObserver(restore);
    observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    const frame = requestAnimationFrame(restore);
    const timer = setTimeout(() => { observer?.disconnect(); taskViewRestore.current = null; }, 5000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); observer?.disconnect(); };
  }, [activeModal, selectedTaskId, taskProgressLoading, taskProgress?.taskId, draftTask?.coordination?.planId, draftTask?.artifactRevision]);
  useEffect(() => {
    if (activeModal !== 'runDetail' || !selectedRunId) { runDetailsSequence.current++; return; }
    if (!selectedRunData || !['running', 'queued'].includes(selectedRunData.run.status)) return;
    let cancelled = false, pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      const sequence = ++runDetailsSequence.current;
      try {
        const data = await api.getRunDetails(selectedRunId);
        if (!cancelled && sequence === runDetailsSequence.current) { setSelectedRunData(data); setRunLogError(''); }
      } catch (reason) {
        if (!cancelled && sequence === runDetailsSequence.current) setRunLogError(reason instanceof Error ? reason.message : '日志刷新失败');
      } finally { pending = false; }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeModal, selectedRunId, selectedRunData?.run.status]);

  // 绑定 SSE 监听
  useEffect(() => {
    const unsubscribe = subscribeEvents(
      () => {
        if (refreshDebounceTimer.current) return;
        refreshDebounceTimer.current = setTimeout(() => {
          refreshDebounceTimer.current = null;
          loadBootstrap();
          if (activeRoomId) {
            loadRoomMessages(activeRoomId);
          }
        }, 300);
      },
      (status) => {
        setSseStatus(status);
      }
    );

    return () => {
      unsubscribe();
      if (refreshDebounceTimer.current) {
        clearTimeout(refreshDebounceTimer.current);
        refreshDebounceTimer.current = null;
      }
    };
  }, [loadBootstrap, loadRoomMessages, activeRoomId]);

  // Escape 键关闭弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && !confirmConfig && !discardMemberOpen
          && !memberSaveLock.current && activeModal && !['createTask', 'createRoom', 'createMeeting', 'managedRequest'].includes(activeModal)) {
        if (activeModal === 'memberEdit' || activeModal === 'memberCreate') {
          closeMemberModal();
          return;
        }
        if ((activeModal === 'runDetail' && runReturnTask) || (activeModal === 'artifactPreview' && previewReturnTask)) {
          setActiveModal('taskDetail');
        } else if (activeModal === 'taskDetail') {
          closeTaskInspector();
        } else {
          setActiveModal(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, runReturnTask, previewReturnTask, confirmConfig, discardMemberOpen, memberFormDirty,
    route.taskId, route.view, route.roomId]);

  useEffect(() => {
    if (!activeModal || confirmConfig) return;
    const dialog = document.querySelector<HTMLElement>('.modal-content');
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const title = dialog.querySelector<HTMLElement>('.modal-title');
    if (title) dialog.setAttribute('aria-label', title.textContent || '对话框');
    if (dialog.closest('.workbench-detail-dock')) {
      dialog.setAttribute('role', 'region');
      dialog.removeAttribute('aria-modal');
      return;
    }
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
    )).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault(); items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault(); items[0].focus();
      }
    };
    dialog.addEventListener('keydown', trap);
    return () => { dialog.removeEventListener('keydown', trap); previous?.focus(); };
  }, [activeModal, selectedRunData?.run.id, taskDockElement, confirmConfig]);

  // 工具方法：获取成员对象
  const getMember = (id?: string | null): Member | undefined => {
    if (!id || !bootstrap) return undefined;
    return bootstrap.members.find((m) => m.id === id);
  };

  // 工具方法：获取任务对象
  const getTask = (id?: string | null): Task | undefined => {
    if (!id || !bootstrap) return undefined;
    return bootstrap.tasks.find((t) => t.id === id);
  };

  // 发送消息
  const handleSendMessage = async () => {
    if (!activeRoomId || (!messageBody.trim() && !roomDraft.values.sendRequestId) || !roomDraft.loaded || sendingMessageRef.current.has(activeRoomId)) return;
    const roomId = activeRoomId;
    const audience = messageAudience(messageBody, selectedRecipientIds, bootstrap?.members || []);
    const contextTaskId = activeRoom?.taskId || messageTaskId;
    const issue = audience.problems[0] || (!messageBody.trim() ? '请填写消息。' : '') || (messageBody.trim().length > 12000 ? '消息最多 12000 字。' : '')
      || (contextTaskId && !roomTasks.some((task) => task.id === contextTaskId) ? '关联任务已不可用，请重新选择。' : '');
    sendingMessageRef.current.add(roomId);
    setSendingRooms((previous) => ({ ...previous, [roomId]: true }));
    setMessageErrors((previous) => ({ ...previous, [roomId]: '' }));
    try {
      const { clearBody } = await deliverRoomMessage(roomId, { body: messageBody,
        recipientIds: selectedRecipientIds, analysisOnly, taskId: contextTaskId || undefined }, roomDraft, issue);
      void loadRoomMessages(roomId);
      // These methods belong to the sending room's draft entry, even if the
      // user has switched rooms while the HTTP request was in flight.
      roomDraft.setValues({ sendRequestId: '', ...(clearBody ? { body: '' } : {}) });
      if (!clearBody) setMessageErrors((previous) => ({ ...previous, [roomId]: '原消息已送达；修改后的内容仍在草稿中，尚未发送。' }));
      if (!await roomDraft.flush()) setMessageErrors((previous) => ({ ...previous, [roomId]: '消息已发送，但草稿清理尚未保存，请重试保存草稿。' }));
      await loadBootstrap();
    } catch (err: unknown) {
      setMessageErrors((previous) => ({ ...previous, [roomId]: err instanceof Error ? err.message : '发送消息失败，草稿已保留。' }));
    } finally {
      sendingMessageRef.current.delete(roomId);
      setSendingRooms((previous) => ({ ...previous, [roomId]: false }));
    }
  };

  const handleDiscussionCreated = async (roomId: string) => {
    await loadBootstrap();
    setActiveRoomId(roomId); navigate('rooms', { roomId, replace: true }); setActiveModal(null);
    await loadRoomMessages(roomId);
  };

  // 发现成员
  const handleDiscoverMembers = async () => {
    if (memberActionLocks.current.has('discover')) return;
    memberActionLocks.current.add('discover');
    setMemberPending(previous => ({ ...previous, discover: true })); setMemberNotice('');
    try {
      const res = await api.discoverMembers();
      await loadBootstrap();
      const clients = res.members.filter(member => member.provider !== 'controller' && member.provider !== 'custom');
      setMemberNotice(`扫描完成：${clients.filter(member => member.detected).length} 位官方 CLI 成员已找到入口。可在成员卡片中检查接入状态。`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '发现成员失败，请重试');
    } finally {
      memberActionLocks.current.delete('discover'); setMemberPending(previous => ({ ...previous, discover: false }));
    }
  };

  // 切换成员启用状态
  const handleToggleMember = async (member: Member) => {
    if (member.provider === 'controller' || memberActionLocks.current.has(member.id)) return;
    memberActionLocks.current.add(member.id);
    setMemberPending(previous => ({ ...previous, [member.id]: true }));
    try {
      await api.updateMember(member.id, { enabled: !member.enabled });
      await loadBootstrap();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '更新成员状态失败，请重试');
    } finally {
      memberActionLocks.current.delete(member.id); setMemberPending(previous => ({ ...previous, [member.id]: false }));
    }
  };

  // 保存成员编辑
  const handleSaveMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (memberSaveLock.current) return;
    setMemberError('');
    let prefixArgsArr: string[] = [];
    let customArgsArr: string[] = [];

    if (memberForm.prefixArgs.trim()) {
      try {
        const parsed = JSON.parse(memberForm.prefixArgs);
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
          setMemberError('前置参数必须是 JSON 字符串数组');
          return;
        }
        prefixArgsArr = parsed;
      } catch {
        setMemberError('前置参数格式不正确，必须为合法 JSON 数组');
        return;
      }
    }

    if (memberForm.provider === 'custom' && memberForm.customArgs.trim()) {
      try {
        const parsed = JSON.parse(memberForm.customArgs);
        if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
          setMemberError('自定义参数必须是 JSON 字符串数组，例如: ["--prompt", "{prompt}"]');
          return;
        }
        customArgsArr = parsed;
      } catch {
        setMemberError('自定义参数格式不正确，必须为合法 JSON 数组');
        return;
      }
    }

    memberSaveLock.current = true; setMemberSaving(true);
    try {
      const data = { ...memberForm, prefixArgs: prefixArgsArr, customArgs: customArgsArr };
      const saved = activeModal === 'memberEdit' && selectedMember
        ? await api.updateMember(selectedMember.id, data)
        : await api.createMember(data);
      // Keep the current probe result and model options available when the
      // modal is reopened before the bootstrap refresh completes.
      setSavedMemberSnapshot(saved);
      setSelectedMember(activeModal === 'memberEdit' ? saved : null);
      if (activeModal === 'memberEdit') {
        setMemberForm(current => ({ ...current, model: saved.model || '' }));
      }
      memberFormInitial.current = '';
      setActiveModal(null);
      if (activeModal !== 'memberEdit') setSelectedMember(null);
      await loadBootstrap();
    } catch (err: unknown) {
      setMemberError(err instanceof Error ? err.message : '保存成员失败，填写内容已保留');
    } finally {
      memberSaveLock.current = false; setMemberSaving(false);
    }
  };

  // 打开成员编辑弹窗
  const openMemberEditModal = (member: Member) => {
    const current = savedMemberSnapshot?.id === member.id ? savedMemberSnapshot : member;
    setMemberError('');
    setSelectedMember(current);
    const next = {
      skills: current.skills || '',
      name: current.name,
      handle: current.handle,
      provider: current.provider,
      role: current.role,
      model: current.model || '',
      executable: current.executable || '',
      prefixArgs: current.prefixArgs ? JSON.stringify(current.prefixArgs) : '',
      customArgs: current.customArgs ? JSON.stringify(current.customArgs) : '',
      inputMode: current.inputMode,
      enabled: current.enabled,
      permission: current.permission,
      dshConfigProfile: current.dshConfigProfile || 'auto',
    };
    memberFormInitial.current = JSON.stringify(next);
    setMemberForm(next);
    setActiveModal('memberEdit');
  };

  const closeMemberModal = () => {
    if (memberSaveLock.current) return;
    if (memberFormDirty) { setDiscardMemberOpen(true); return; }
    setActiveModal(null);
    setSelectedMember(null);
  };
  const discardMemberChanges = () => {
    memberFormInitial.current = '';
    setDiscardMemberOpen(false);
    setSelectedMember(null);
    setMemberError('');
    setActiveModal(null);
  };
  useEffect(() => {
    if (!savedMemberSnapshot || !bootstrap) return;
    const current = bootstrap.members.find((member) => member.id === savedMemberSnapshot.id);
    if (current && current.model === savedMemberSnapshot.model && current.runtime?.fingerprint === savedMemberSnapshot.runtime?.fingerprint) {
      setSavedMemberSnapshot(null);
    }
  }, [bootstrap, savedMemberSnapshot]);

  const handleTaskCreated = async (task: Task, warning?: string, cleanup?: () => Promise<boolean>) => {
    // The creation receipt already proves this task exists. Keep it visible
    // even if the following list refresh fails, and reject older list reads.
    bootstrapSequence.current++;
    setBootstrap(current => current ? { ...current, tasks: current.tasks.some(item => item.id === task.id)
      ? current.tasks.map(item => item.id === task.id && item.updatedAt <= task.updatedAt ? task : item)
      : [task, ...current.tasks] } : current);
    setSelectedTaskId(task.id);
    setReturnToTaskCreation(false);
    setReturnToManagedRequest(null);
    setActiveModal('taskDetail');
    openTask(activeTab === 'rooms' && task.roomId ? 'rooms' : 'tasks', {
      roomId: activeTab === 'rooms' ? task.roomId : null, taskId: task.id,
    });
    if (warning) setTaskNotices(current => ({ ...current, [task.id]: { tone: 'warning', text: warning, cleanup } }));
    void loadBootstrap();
  };

  const handleArchive = async (kind: 'tasks' | 'rooms', id: string, archived: boolean) => {
    const taskId = kind === 'tasks' ? id : bootstrap?.rooms.find((room) => room.id === id)?.taskId;
    if (archiveActionLock.current || (taskId && !beginTaskOperation(taskId, 'archive'))) return;
    archiveActionLock.current = true;
    setArchiveBusy(true);
    try {
      await api.setArchived(kind, id, archived);
      if (taskId && isCurrentTaskDetail(taskId)) closeTaskInspector();
      await loadBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : '归档操作失败');
    } finally {
      archiveActionLock.current = false;
      setArchiveBusy(false);
      if (taskId) reportTaskBusy(taskId, 'archive', false);
    }
  };
  const rememberTaskView = () => {
    if (activeModal !== 'taskDetail' || !selectedTaskId) return;
    const body = document.querySelector<HTMLElement>('[data-task-detail] .modal-body');
    if (!body) return;
    const input = lastTaskInput.current?.taskId === selectedTaskId ? lastTaskInput.current.input : null;
    const field = input && body.contains(input) ? input : null;
    const selector = field?.dataset.draftQuestion ? `[data-draft-question="${CSS.escape(field.dataset.draftQuestion)}"]`
      : field?.dataset.testid ? `[data-testid="${CSS.escape(field.dataset.testid)}"]` : undefined;
    taskViewRestore.current = { taskId: selectedTaskId, planId: draftTask?.coordination?.planId,
      artifactRevision: draftTask?.artifactRevision, scrollTop: body.scrollTop, selector,
      selectionStart: field?.selectionStart, selectionEnd: field?.selectionEnd };
  };
  const openArtifact = (artifact: Artifact, returnToTask = false) => {
    if (returnToTask) rememberTaskView();
    setPreviewArtifact(artifact);
    setPreviewReturnTask(returnToTask);
    setActiveModal('artifactPreview');
  };

  const applyTaskResult = (updated: Task) => {
    // Invalidate list reads started before the mutation receipt. A newer task
    // received through SSE must also win over a delayed mutation response.
    bootstrapSequence.current++;
    setBootstrap(current => current ? { ...current, tasks: current.tasks.map(task => task.id !== updated.id
      || task.updatedAt > updated.updatedAt ? task : updated) } : current);
  };
  const setTaskNotice = (id: string, tone: 'error' | 'success' | 'warning', text: string, cleanup?: () => Promise<boolean>) => {
    setTaskNotices(current => ({ ...current, [id]: { tone, text, cleanup } }));
  };
  const cleanupTaskDraft = async (taskId: string) => {
    const cleanup = taskNotices[taskId]?.cleanup;
    if (!cleanup || !beginTaskOperation(taskId, 'refresh')) return;
    try {
      if (await cleanup()) setTaskNotice(taskId, 'success', '已清理提交时的草稿，任务结果已保留');
      else setTaskNotice(taskId, 'warning', '任务已提交，草稿仍未清理。请重试清理后再退出。', cleanup);
    } finally { reportTaskBusy(taskId, 'refresh', false); }
  };
  const requireTaskRefresh = (id: string, required: boolean) => {
    taskNeedsRefreshRef.current = { ...taskNeedsRefreshRef.current, [id]: required };
    setTaskNeedsRefresh(current => ({ ...current, [id]: required }));
  };
  const checkTaskStatus = async (taskId: string) => {
    if (hasTaskBusy(taskBusyRef.current[taskId])) return;
    reportTaskBusy(taskId, 'refresh', true);
    try {
      const data = await api.getBootstrap(true);
      const task = data.tasks.find(item => item.id === taskId);
      if (!task) throw new Error('任务不存在，请返回任务列表核对');
      applyTaskResult(task);
      requireTaskRefresh(taskId, false);
      setTaskNotice(taskId, 'warning', `已核对当前状态：${taskStatusNames[task.status]}。请按当前状态继续操作。`);
      await refreshTask();
    } catch (reason) { setTaskNotice(taskId, 'error', `当前状态尚未核对：${reason instanceof Error ? reason.message : '读取失败'}。请重试刷新任务状态。`); }
    finally { reportTaskBusy(taskId, 'refresh', false); }
  };
  const runTaskOperation = async (task: Task, operation: 'start' | 'accept' | 'revise', send: () => Promise<Task>,
    success: string, draft?: { clear: () => Promise<boolean>; retry: () => Promise<boolean> }) => {
    if (!beginTaskOperation(task.id, operation)) return;
    const previousRuns = new Set([...(bootstrap?.runs || []), ...(taskProgress?.taskId === task.id ? taskProgress.runs : [])].map(run => run.id));
    setTaskNotices(current => { const next = { ...current }; delete next[task.id]; return next; });
    try {
      const updated = await send();
      applyTaskResult(updated);
      const cleared = draft ? await draft.clear() : true;
      setTaskNotice(task.id, cleared ? 'success' : 'warning', `${success}${cleared ? '' : '。文字草稿清理失败，原内容仍保留，请重试清理后再退出。'}`, cleared ? undefined : draft?.retry);
      if (isCurrentTaskDetail(task.id)) { setAcknowledgeMissingGate(false); setShowReviseInput(false); }
    } catch (reason) {
      // Only read after a missing receipt. Never silently repeat a start,
      // revision or acceptance just because the first response was lost.
      const snapshot = await api.getBootstrap(true).catch(() => null);
      const updated = snapshot?.tasks.find(item => item.id === task.id);
      if (updated) applyTaskResult(updated);
      const observed = updated && (operation === 'accept' ? updated.status === 'done'
        : snapshot?.runs.some(run => run.taskId === task.id && ['implement', 'plan'].includes(run.stage) && !previousRuns.has(run.id)));
      if (observed) {
        setTaskNotice(task.id, 'warning', `本次请求回执未收到，已核对：${operation === 'accept' ? '任务已验收完成' : '任务已产生新的执行记录'}。请查看当前进度。`);
        if (isCurrentTaskDetail(task.id)) { setAcknowledgeMissingGate(false); setShowReviseInput(false); }
      } else {
        const detail = reason instanceof Error ? reason.message : '操作未完成';
        setTaskNotice(task.id, 'error', `${detail}${updated ? '。填写内容已保留，可以重试。' : '。暂时无法核对任务状态，请先刷新任务状态再操作。'}`);
        if (!updated) requireTaskRefresh(task.id, true);
      }
    } finally {
      await refreshTask();
      reportTaskBusy(task.id, operation, false);
    }
  };

  // 启动任务
  const handleStartTask = async (taskId: string, feedback = '') => {
    const progress = taskProgress?.taskId === taskId ? taskProgress : null;
    const task = bootstrap?.tasks.find((item) => item.id === taskId);
    if (!progress || progress.active || taskProgressLoading || taskProgressError || !isCurrentTaskDetail(taskId)
        || !task || (needsAssistanceAnswer(task, progress) && !feedback.trim())
        || !assignmentDrafts[taskId]?.ready || assignmentDrafts[taskId]?.dirty) return;
    await runTaskOperation(task, 'start', () => feedback.trim() ? api.reviseTask(taskId, feedback.trim()) : api.startTask(taskId),
      feedback.trim() ? '纠正要求已提交，请查看当前进度' : '启动请求已提交，请查看当前进度', feedback.trim() ? revisionDraft : undefined);
  };

  // 撤销/取消任务（破坏性操作确认）
  const promptCancelTask = (taskId: string) => {
    if (isTaskBusy(taskId) || confirmActionLock.current) return;
    const task = bootstrap?.tasks.find(item => item.id === taskId);
    setConfirmError('');
    setConfirmConfig({
      kind: 'task', id: taskId, taskId,
      title: '取消任务',
      message: `取消“${task?.title || '当前任务'}”后将终止其作业，任务不能再继续。已有文件和记录会保留。${task?.status === 'running' ? '如果只是暂时停下，请返回任务并使用“暂停任务”。' : ''}`,
      confirmText: '确认取消',
      returnText: '返回任务',
    });
  };

  // 验收通过任务
  const handleAcceptTask = async (task: Task) => {
    if (isTaskBusy(task.id) || task.archivedAt || task.status !== 'review' || !acceptanceDraft.loaded) return;
    const issue = acceptanceIssue(task, acceptNote, acknowledgeMissingGate);
    if (issue) { setTaskNotice(task.id, 'error', issue); return; }
    await runTaskOperation(task, 'accept', () => api.acceptTask(task.id, acceptNote.trim(), acknowledgeMissingGate),
      '验收已通过，任务已完成', acceptanceDraft);
  };

  // 要求修改任务
  const handleReviseTask = async (task: Task) => {
    if (isTaskBusy(task.id) || task.archivedAt || task.status !== 'review' || !revisionDraft.loaded) return;
    if (!reviseFeedback.trim()) {
      setTaskNotice(task.id, 'error', '请提供具体的修改要求与反馈');
      return;
    }
    await runTaskOperation(task, 'revise', () => api.reviseTask(task.id, reviseFeedback.trim()),
      '修改要求已提交，请查看当前进度', revisionDraft);
  };

  // 查看 Run 详情与日志
  const openRunDetail = async (runId: string) => {
    rememberTaskView();
    const sequence = ++runDetailsSequence.current;
    setSelectedRunId(runId);
    setSelectedRunData(null);
    setRunLogError('');
    setRunReturnTask(activeModal === 'taskDetail');
    setActiveModal('runDetail');
    try {
      const data = await api.getRunDetails(runId);
      if (sequence === runDetailsSequence.current) setSelectedRunData(data);
    } catch (err: unknown) {
      if (sequence !== runDetailsSequence.current) return;
      setRunLogError(err instanceof Error ? err.message : '获取作业详情失败');
    }
  };
  const retryRunDetail = async () => {
    if (!selectedRunId) return;
    const sequence = ++runDetailsSequence.current;
    setRunLogError('');
    try {
      const result = await api.getRunDetails(selectedRunId);
      if (sequence === runDetailsSequence.current) setSelectedRunData(result);
    } catch (reason) {
      if (sequence === runDetailsSequence.current) setRunLogError(reason instanceof Error ? reason.message : '日志读取失败');
    }
  };

  // 取消 Run（破坏性操作确认）
  const promptCancelRun = (runId: string) => {
    const run = selectedRunData?.run.id === runId ? selectedRunData.run : bootstrap?.runs.find((item) => item.id === runId);
    const taskId = run?.taskId || run?.contextTaskId;
    if (isTaskBusy(taskId) || confirmActionLock.current) return;
    setConfirmError('');
    setConfirmConfig({
      kind: 'run', id: runId, taskId,
      title: run?.meetingId ? '结束本轮讨论' : '终止执行作业',
      message: run?.meetingId ? '将结束本轮讨论，同时停止这轮讨论中其他正在执行或排队的作业。已有消息和日志会保留。'
        : run?.status === 'queued' ? '该作业尚未开始，终止后会从执行队列移除。已有文件和日志会保留。'
          : `将停止当前作业，已有文件和日志会保留。${run?.taskId ? '所属任务会停止推进，可在成员停止后处理并继续。' : '其他任务不受影响。'}`,
      confirmText: run?.meetingId ? '结束讨论' : '确认终止',
      returnText: activeModal === 'runDetail' ? '返回日志' : '返回工作台',
    });
  };
  const confirmCancellation = async () => {
    const config = confirmConfig;
    if (!config || confirmActionLock.current || (config.taskId && !beginTaskOperation(config.taskId, 'cancel'))) return;
    confirmActionLock.current = true; setConfirmBusy(true); setConfirmError('');
    try {
      if (config.kind === 'task') {
        applyTaskResult(await api.cancelTask(config.id));
        setTaskNotice(config.id, 'success', '任务已取消，已有文件和记录已保留');
      } else {
        const updated = await api.cancelRun(config.id);
        setSelectedRunData(current => current?.run.id === config.id ? { ...current, run: updated } : current);
      }
      setConfirmConfig(null);
      await refreshTask();
    } catch (reason) {
      let cancelled = false;
      if (config.kind === 'task') {
        const snapshot = await api.getBootstrap(true).catch(() => null);
        const task = snapshot?.tasks.find(item => item.id === config.id);
        if (task) applyTaskResult(task);
        cancelled = task?.status === 'cancelled';
        if (cancelled) setTaskNotice(config.id, 'warning', '本次取消回执未收到，已核对：任务已取消，已有文件和记录已保留');
      } else {
        const details = await api.getRunDetails(config.id).catch(() => null);
        if (details) setSelectedRunData(current => current?.run.id === config.id ? details : current);
        cancelled = details?.run.status === 'cancelled';
      }
      if (cancelled) { setConfirmConfig(null); await refreshTask(); }
      else setConfirmError(`${reason instanceof Error ? reason.message : '操作未完成'}。当前页面已保留，可以重试或返回。`);
    } finally {
      if (config.taskId) reportTaskBusy(config.taskId, 'cancel', false);
      confirmActionLock.current = false; setConfirmBusy(false);
    }
  };

  // 切换全局暂停
  const handleToggleGlobalPause = async () => {
    if (!bootstrap || pauseLock.current) return;
    pauseLock.current = true; setPausePending(true);
    const newPaused = !bootstrap.workspace.paused;
    try {
      const updated = await api.updateSettings({ paused: newPaused });
      setBootstrap((prev) =>
        prev
          ? {
              ...prev,
              workspace: {
                ...prev.workspace,
                paused: updated.paused,
              },
            }
          : null
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '切换工作区状态失败');
    } finally { pauseLock.current = false; setPausePending(false); }
  };

  // 成员 Provider 渲染辅助
  const renderProviderBadge = (provider: Member['provider']) => {
    const monogramMap: Record<Member['provider'], string> = {
      antigravity: 'A',
      dsh: 'D',
      claude: 'C',
      gemini: 'G',
      codex: 'O',
      opencode: 'P',
      custom: 'U',
      controller: 'K',
    };
    return (
      <span className={`provider-badge provider-${provider}`} title={`提供方: ${provider}`}>
        <span style={{ fontWeight: 700 }}>{monogramMap[provider] || 'U'}</span>
        {provider}
      </span>
    );
  };

  // 门禁状态徽章渲染
  const renderGateBadge = (gate: Task['gate']) => {
    const labels: Record<Task['gate']['status'], string> = {
      not_configured: '未配置门禁',
      pending: '门禁待验证',
      passed: '门禁已通过',
      failed: '门禁未通过',
      stale: '门禁已过期',
    };
    return (
      <span className={`gate-badge gate-${gate.status}`}>
        <ShieldCheck size={12} />
        {labels[gate.status] || gate.status}
      </span>
    );
  };

  // 获取当前房间与正在进行的作业
  const activeRoom = bootstrap?.rooms.find((r) => r.id === activeRoomId);
  const openManagedRequest = (roomId = activeRoom?.kind === 'team' && !activeRoom.archivedAt ? activeRoom.id : 'team') => {
    setManagedRequestRoomId(roomId); setReturnToManagedRequest(null); setActiveModal('managedRequest');
  };
  const visibleTasks = (bootstrap?.tasks || []).filter((task) => !task.archivedAt);
  const visibleRooms = (bootstrap?.rooms || []).filter((room) => !room.archivedAt);
  const visibleArtifacts = (bootstrap?.artifacts || []).filter((artifact) => visibleTasks.some((task) => task.id === artifact.taskId));
  const roomTasks = visibleTasks.filter((task) => task.roomId === activeRoomId);
  const roomArtifacts = (bootstrap?.artifacts || []).filter((artifact) => roomTasks.some((task) => task.id === artifact.taskId));
  const activeRoomRuns = (bootstrap?.runs || []).filter(
    (run) => run.roomId === activeRoomId && (run.status === 'running' || run.status === 'queued')
  );

  // 过滤启用的非控制器成员（用于发送消息接收人与讨论成员选择）
  const enabledNonControllerMembers = (bootstrap?.members || []).filter(isMemberRunnable);

  // 格式化文件大小
  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const openTaskInspector = (id: string, section?: string) => {
    if (!getTask(id)) { setError('该任务未在当前工作区列表中，请在归档中查找。'); return; }
    setSelectedTaskId(id);
    setTaskSection(section ? { taskId: id, section } : null);
    setActiveModal('taskDetail');
    openTask(activeTab === 'rooms' ? 'rooms' : 'tasks', { roomId: activeTab === 'rooms' ? activeRoomId : null, taskId: id });
  };
  const closeTaskInspector = () => {
    setTaskSection(null);
    setSelectedTaskId(null);
    setActiveModal(null);
    closeTask();
  };
  const renderInspection = (content: React.ReactNode) => activeTab === 'rooms' && taskDockElement
    ? createPortal(content, taskDockElement) : content;

  return (
    <>
    <div className="app-layout" ref={appLayout} inert={desktopLeaving} aria-busy={desktopLeaving || undefined}>
      {/* 顶部紧凑导航栏 */}
      <header className="app-header">
        <div className="brand-section">
          <button
            className="btn btn-icon-only btn-secondary mobile-nav-toggle"
            onClick={() => setMobileNavOpen((v) => !v)}
            title="展开/收起菜单"
            aria-label="展开/收起菜单"
          >
            <Menu size={16} />
          </button>
          <div className="brand-title">
            <img src="/brand.png" alt="" width={28} height={28} />
            <span>CLI Team{window.cliTeamDesktop ? ' · 桌面工作台' : ''}</span>
          </div>
          {bootstrap && (
            <div className="header-workspace-badge" title={bootstrap.workspace.root}>
              {bootstrap.workspace.root}
            </div>
          )}
        </div>

        <div className="header-actions">
          <button className="btn btn-sm btn-primary" onClick={() => openManagedRequest()} disabled={!bootstrap}>
            <Send size={13} /><span>交给主控</span>
          </button>
          {/* SSE 状态指示器 */}
          <div className="connection-pill" title={`实时连接状态: ${sseStatus}`}>
            <span className={`status-dot ${sseStatus}`} />
            <span>
              {sseStatus === 'connected'
                ? '已连接'
                : sseStatus === 'connecting'
                ? '连接中'
                : '已断开'}
            </span>
          </div>

          {/* 活跃作业计数 */}
          {bootstrap && (
            <div className="runs-count-pill" title="当前活跃执行作业数">
              <Cpu size={13} />
              <span>活跃作业: {bootstrap.workspace.activeRuns}</span>
            </div>
          )}

          {/* 全局暂停/恢复按钮 */}
          {bootstrap && (
            <button
              className={`btn btn-sm ${
                bootstrap.workspace.paused ? 'btn-warning' : 'btn-secondary'
              }`}
              disabled={pausePending} onClick={handleToggleGlobalPause}
              title={bootstrap.workspace.paused ? '当前已暂停新任务调度，点击恢复' : '暂停新任务调度'}
              aria-label={bootstrap.workspace.paused ? '恢复调度' : '暂停调度'}
            >
              {bootstrap.workspace.paused ? <Play size={13} /> : <Pause size={13} />}
              <span>{bootstrap.workspace.paused ? '恢复调度' : '暂停调度'}</span>
            </button>
          )}
        </div>
      </header>

      {/* 主体工作台 */}
      <div className="app-main">
        {/* 一级侧边栏 */}
        <WorkbenchNav
          activeTab={activeTab}
          mobileNavOpen={mobileNavOpen}
          bootstrap={bootstrap}
          onTabChange={handleTabChange}
        />

        {/* 主内容区域 */}
        <main className="content-surface">
          {error && (
            <div className="error-banner" style={{ margin: '12px 16px 0 16px' }}>
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'attention' && (
            <AttentionView
              tasks={bootstrap?.tasks || []}
              members={bootstrap?.members || []}
              onOpenTask={openTaskInspector}
            />
          )}

          {activeTab === 'fixtures' && <FixtureWorkbench />}

          <RoomWorkbench
            hidden={activeTab !== 'rooms'}
            workspace={bootstrap?.workspace.root || ''} rooms={visibleRooms} roomId={activeRoomId}
            tasks={bootstrap?.tasks || []} members={bootstrap?.members || []} messages={messages}
            loading={roomHistory.loading || (!roomHistory.ready && !roomHistory.error)} error={roomHistory.error} history={roomHistory}
            artifacts={bootstrap?.artifacts || []} runs={bootstrap?.runs || []}
            selectedTaskId={selectedTaskId} progress={taskProgress} dockRef={setTaskDockElement}
            inspectorOpen={['taskDetail', 'runDetail', 'artifactPreview'].includes(activeModal || '')}
            archiveBusy={archiveBusy} busyTaskIds={Object.keys(taskBusy).filter((id) => hasTaskBusy(taskBusy[id]))}
            onRoom={(id) => {
              setActiveRoomId(id);
              if (id !== activeRoomId) {
                setSelectedTaskId(null);
                if (['taskDetail', 'runDetail', 'artifactPreview'].includes(activeModal || '')) setActiveModal(null);
              }
              navigate('rooms', { roomId: id, replace: true });
            }}
            onRefresh={() => { if (activeRoomId) void loadRoomMessages(activeRoomId); }}
            onCreateRoom={() => setActiveModal('createRoom')}
            onCreateTask={() => { setTaskCreateSeed({ executionMode: 'delegated' }); setActiveModal('createTask'); }}
            onMeeting={() => setActiveModal('createMeeting')}
            onOpenTask={openTaskInspector} onOpenRun={openRunDetail} onArtifact={openArtifact}
            onCancelRun={promptCancelRun} onArchiveRoom={(id) => { void handleArchive('rooms', id, true); }}
            composer={{
              body: messageBody, recipientIds: selectedRecipientIds, taskId: messageTaskId, analysisOnly,
              sending: Boolean(activeRoomId && sendingRooms[activeRoomId]), loaded: roomDraft.loaded, pendingReceipt: Boolean(roomDraft.values.sendRequestId),
              saving: roomDraft.saving, draftError: roomDraft.error, error: activeRoomId ? messageErrors[activeRoomId] || '' : '',
              onBody: (body) => {
                roomDraft.setField('body', body);
                if (activeRoomId) setMessageErrors((previous) => ({ ...previous, [activeRoomId]: '' }));
              },
              onRecipients: (ids) => roomDraft.setField('recipientIds', JSON.stringify(ids)),
              onTask: (id) => roomDraft.setField('taskId', id),
              onClearTask: () => roomDraft.setField('taskId', ''),
              onAnalysis: (value) => { if (activeRoomId) setAnalysisRooms((previous) => ({ ...previous, [activeRoomId]: value })); },
              onSend: handleSendMessage, onRetryDraft: () => { void roomDraft.retry(); },
            }} />


          {/* 2. 任务看板视图 */}
          {activeTab === 'tasks' && (
            <div className="tasks-view">
              <div className="tasks-toolbar">
                <h2 className="view-title">任务工作流看板</h2>
                <button className="btn btn-primary" onClick={() => openManagedRequest()}><Send size={14} /><span>提交目标</span></button>
                <button className="btn btn-primary" onClick={() => {
                  setTaskCreateSeed({ executionMode: 'delegated' });
                  setActiveModal('createTask');
                }}><Users size={14} /><span>新建负责人协作任务</span></button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setTaskCreateSeed({ executionMode: 'direct', assigneeId: enabledNonControllerMembers[0]?.id || '' });
                    setActiveModal('createTask');
                  }}
                >
                  <Plus size={14} />
                  <span>新建单人任务</span>
                </button>
              </div>
              {!visibleTasks.length && <div className="tasks-empty" role="status">
                <CheckSquare size={28} />
                <strong>还没有任务</strong>
                <p>可以直接提交目标，让主控安排团队；也可以先选择一名成员创建单人任务。</p>
                <div>
                  <button className="btn btn-primary" onClick={() => openManagedRequest()}>提交第一个目标</button>
                  <button className="btn btn-secondary" onClick={() => {
                    setTaskCreateSeed({ executionMode: 'direct', assigneeId: enabledNonControllerMembers[0]?.id || '' });
                    setActiveModal('createTask');
                  }}>创建单人任务</button>
                </div>
              </div>}

              {/* 6 列看板 */}
              <div className="kanban-board">
                {(
                  [
                    { key: 'backlog', title: '待处理' },
                    { key: 'running', title: '执行中' },
                    { key: 'review', title: '待你验收' },
                    { key: 'done', title: '已完成' },
                    { key: 'blocked', title: '已阻塞' },
                    { key: 'cancelled', title: '已取消' },
                  ] as const
                ).map((col) => {
                  const colTasks = visibleTasks.filter(
                    (t) => t.status === col.key
                  );
                  return (
                    <div key={col.key} className="kanban-col">
                      <div className="kanban-col-header">
                        <span>{col.title}</span>
                        <span className="kanban-count">{colTasks.length}</span>
                      </div>
                      <div className="kanban-cards-area">
                        {colTasks.map((t) => {
                          const assignee = getMember(t.assigneeId);
                          return (
                            <div
                              key={t.id}
                              className="task-card"
                              role="button"
                              tabIndex={0}
                              aria-label={`${t.title} ${taskStatusNames[t.status]}`}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  openTaskInspector(t.id);
                                }
                              }}
                              onClick={() => openTaskInspector(t.id)}
                            >
                              <div className="task-card-title">{t.title}</div>
                              <div className="task-card-objective">{t.objective.slice(0, 160)}{t.objective.length > 160 ? '...' : ''}</div>
                              <div className="task-card-meta">
                                <span>{assignee ? `@${assignee.handle}` : '未分配'}</span>
                                {renderGateBadge(t.gate)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'archive' && <div className="archive-view">
            <div className="view-header"><h2 className="view-title">归档记录</h2></div>
            <h3>任务</h3>
            {(bootstrap?.tasks || []).filter((task) => task.archivedAt).map((task) => <div className="archive-row" key={task.id}>
              <button className="file-link" onClick={() => openTaskInspector(task.id)}>
                <FileText size={14} /><span>{task.title}</span></button>
              <small>{taskStatusNames[task.status]}</small>
              <button className="btn btn-secondary btn-icon-only" title={`恢复任务 ${task.title}`} aria-label={`恢复任务 ${task.title}`}
                disabled={archiveBusy || hasTaskBusy(taskBusy[task.id])} onClick={() => handleArchive('tasks', task.id, false)}><ArchiveRestore size={15} /></button>
            </div>)}
            {!bootstrap?.archived?.tasks && <div className="empty-state">暂无归档任务</div>}
            <h3>频道</h3>
            {(bootstrap?.rooms || []).filter((room) => room.archivedAt && room.kind === 'team').map((room) => <div className="archive-row" key={room.id}>
              <span>{room.name}</span>
              <button className="btn btn-secondary btn-icon-only" title={`恢复频道 ${room.name}`} aria-label={`恢复频道 ${room.name}`}
                disabled={archiveBusy} onClick={() => handleArchive('rooms', room.id, false)}><ArchiveRestore size={15} /></button>
            </div>)}
          </div>}

          {/* 3. 成员管理视图 */}
          {activeTab === 'external' && <ExternalSessions imports={bootstrap?.externalSessions || []} onChange={loadBootstrap}
            onRelay={(session) => {
              setTaskCreateSeed({
                title: `${session.title.slice(0, 95)} · 接力`,
                objective: '',
                executionMode: 'direct', participantIds: [],
                assigneeId: enabledNonControllerMembers.find((member) => member.provider === 'dsh' && member.role === 'builder')?.id || enabledNonControllerMembers[0]?.id || '',
                reviewerId: enabledNonControllerMembers.find((member) => member.provider === 'antigravity' && member.role === 'reviewer')?.id || '',
                requirements: '仅使用任务目录内材料\n保留原会话和原文件\n缺少证据时停止并列明',
                sourceSessionId: session.sessionId, sourceTitle: session.title,
              });
              setActiveModal('createTask');
            }} />}
          {activeTab === 'members' && (
            <div className="members-view">
              {returnToManagedRequest && <div className="task-prepared-note" role="status">
                <span>目标草稿已保存。配置好成员后，返回设置主控与协作团队。</span>
                <button className="btn btn-secondary" onClick={() => handleTabChange('settings')}>返回配置主控团队</button>
              </div>}
              {returnToTaskCreation && <div className="task-prepared-note" role="status">
                <span>任务填写草稿已保存。配置好成员后可继续准备。</span>
                <button className="btn btn-secondary" onClick={() => { setReturnToTaskCreation(false); setActiveModal('createTask'); }}>返回继续填写任务</button>
              </div>}
              <div className="view-header">
                <div>
                  <h2 className="view-title">团队与 CLI 代理</h2>
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                    {bootstrap?.members.filter((member) => member.enabled).length || 0} 名已启用成员
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn btn-secondary" disabled={memberPending.discover} onClick={handleDiscoverMembers}>
                    <Search size={14} />
                    <span>{memberPending.discover ? '正在扫描…' : '自动发现已安装 CLI'}</span>
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setSelectedMember(null); setMemberError('');
                      const next: typeof memberForm = {
                        skills: '',
                        name: '',
                        handle: '',
                        provider: 'antigravity',
                        role: 'builder',
                        model: '',
                        executable: '',
                        prefixArgs: '',
                        customArgs: '',
                        inputMode: 'argument',
                        enabled: true,
                        permission: 'edit',
                        dshConfigProfile: 'auto',
                      };
                      memberFormInitial.current = JSON.stringify(next);
                      setMemberForm(next);
                      setActiveModal('memberCreate');
                    }}
                  >
                    <Plus size={14} />
                    <span>添加代理成员</span>
                  </button>
                </div>
              </div>

              {memberNotice && <p role="status">{memberNotice}</p>}
              <div className="members-grid">
                {bootstrap?.members.map((m) => {
                  const isController = m.provider === 'controller';
                  return (
                    <div key={m.id} className="member-card">
                      <div className="member-card-header">
                        <div className="member-info-left">
                          <div className={`provider-avatar provider-${m.provider}`} title={m.provider}>
                            {isController ? <ShieldCheck size={16} /> : <Terminal size={16} />}
                          </div>
                          <div>
                            <div className="member-name">{m.name}</div>
                            <div className="member-handle">@{m.handle}</div>
                          </div>
                        </div>
                        <div>
                          <span
                            className={`badge ${
                              m.enabled ? 'badge-success' : 'badge-muted'
                            }`}
                            style={{
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: m.enabled ? 'var(--success-light)' : 'var(--border-color)',
                              color: m.enabled ? 'var(--success)' : 'var(--text-muted)',
                            }}
                          >
                            {isController ? '按需主控' : m.status === 'busy' ? '执行中'
                              : m.status === 'missing' ? '未检测到'
                              : m.status === 'disabled' ? '已停用' : '已启用'}
                          </span>
                        </div>
                      </div>

                      <div className="member-card-details">
                        {!isController && <div className="member-prop-row">
                          <span>擅长技能:</span>
                          <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 }}>{m.skills || '未填写'}</span>
                        </div>}
                        <div className="member-prop-row">
                          <span>角色:</span>
                          <strong>
                            {m.role === 'builder'
                              ? '构建者'
                              : m.role === 'reviewer'
                              ? '评审者'
                              : m.role === 'researcher'
                              ? '调研者'
                              : '中枢控制器'}
                          </strong>
                        </div>
                        <div className="member-prop-row">
                          <span>执行文件:</span>
                          <span className="mono-path" title={m.executable}>{isController ? '主控工具接口' : m.executable || '(未检测到)'}</span>
                        </div>
                        <div className="member-prop-row">
                          <span>模型:</span>
                          <span className="mono-path" title={m.model}>{m.model || (isController ? '当前 Codex 会话' : '(CLI 默认)')}</span>
                        </div>
                        <div className="member-prop-row">
                          <span>权限:</span>
                          <span>{isController ? '裁决与验收' : m.permission === 'edit' ? '文件编辑' : '只读规划'}</span>
                        </div>
                      </div>

                      {!isController && <MemberConnection member={m} onChanged={loadBootstrap} />}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'flex-end',
                          gap: '6px',
                          marginTop: '6px',
                          paddingTop: '8px',
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        {!isController && (
                          <>
                            <button
                              className="btn btn-sm btn-secondary"
                              disabled={memberPending[m.id]}
                              onClick={() => handleToggleMember(m)}
                            >
                              {memberPending[m.id] ? '正在更新…' : m.enabled ? '停用' : '启用'}
                            </button>
                            <button
                              className="btn btn-sm btn-secondary"
                              disabled={memberPending[m.id]}
                              onClick={() => openMemberEditModal(m)}
                            >
                              编辑配置
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 4. 产物文件视图 */}
          {activeTab === 'artifacts' && (
            <div className="artifacts-view">
              <div className="view-header">
                <div>
                  <h2 className="view-title">生成产物与文件归档</h2>
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                    {bootstrap?.artifacts.length || 0} 个文件
                  </div>
                </div>
              </div>

              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>文件名</th>
                      <th>相对路径</th>
                      <th>所属任务</th>
                      <th>文件大小</th>
                      <th>SHA256 校验和</th>
                      <th>更新时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bootstrap?.artifacts.map((art) => {
                      const task = getTask(art.taskId);
                      return (
                        <tr key={art.id}>
                          <td style={{ fontWeight: 600 }}>{art.name}</td>
                          <td className="mono-path">{art.relativePath}</td>
                          <td>
                            {task ? (
                              <button
                                className="btn btn-sm btn-secondary"
                                onClick={() => openTaskInspector(task.id)}
                              >
                                {task.title}
                              </button>
                            ) : (
                              art.taskId
                            )}
                          </td>
                          <td>{formatFileSize(art.size)}</td>
                          <td className="mono-path" title={art.sha256}>
                            {art.sha256.substring(0, 12)}...
                          </td>
                          <td style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                            {new Date(art.updatedAt).toLocaleString()}
                          </td>
                          <td>
                            {canPreview(art) && <button className="btn btn-sm btn-secondary btn-icon-only" title="预览文件" aria-label={`预览 ${art.name}`}
                              onClick={() => openArtifact(art)}><BookOpen size={13} /></button>}
                            <ArtifactDownload artifact={art} />
                          </td>
                        </tr>
                      );
                    })}
                    {bootstrap?.artifacts.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: '32px' }}>
                          暂无产物文件记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 5. 设置视图 */}
          {bootstrap && (
            <div className="settings-view" hidden={activeTab !== 'settings'} style={activeTab !== 'settings' ? { display: 'none' } : undefined}>
              {returnToManagedRequest && <div className="task-prepared-note" role="status">
                <span>目标草稿已保存。保存主控团队后，可返回继续填写。</span>
                <button className="btn btn-secondary" onClick={() => openManagedRequest(returnToManagedRequest)}>返回继续填写目标</button>
              </div>}
              <div className="view-header">
                <div>
                  <h2 className="view-title">工作区与系统设置</h2>
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                    {bootstrap?.workspace.root}
                  </div>
                </div>
              </div>

              <div className="settings-container">
                <DesktopSettings />
                {bootstrap && <ManagedTeamSettings team={bootstrap.workspace.managedTeam || null} members={bootstrap.members}
                  onSaved={(team) => {
                    bootstrapSequence.current++;
                    setBootstrap(current => current ? { ...current, workspace: { ...current.workspace, managedTeam: team } } : current);
                    void loadBootstrap();
                  }} onMembers={() => handleTabChange('members')} onUnsaved={(value) => { unsavedTeam.current = value; }} />}
                {/* 事实状态信息展示 */}
                <div className="settings-group">
                  <div className="settings-label">工作区基本事实</div>
                  <div className="settings-row">
                    <span style={{ color: 'var(--text-secondary)' }}>工作区根目录</span>
                    <span className="mono-path">{bootstrap?.workspace.root}</span>
                  </div>
                  <div className="settings-row">
                    <span style={{ color: 'var(--text-secondary)' }}>子任务工作区分离路径</span>
                    <span className="mono-path">{bootstrap?.workspace.workspacesPath}</span>
                  </div>
                  <div className="settings-row">
                    <span style={{ color: 'var(--text-secondary)' }}>环境隔离策略</span>
                    <span>目录隔离 (非操作系统沙箱)</span>
                  </div>
                  <div className="settings-row">
                    <span style={{ color: 'var(--text-secondary)' }}>控制器上一次活动</span>
                    <span>
                      {bootstrap?.workspace.controllerLastSeen
                        ? new Date(bootstrap.workspace.controllerLastSeen).toLocaleString()
                        : '无记录'}
                    </span>
                  </div>
                </div>

                <RuntimeSettingsForm settings={bootstrap.workspace}
                  onUnsaved={(value) => { unsavedSettings.current = value; }}
                  onSaved={(updated) => setBootstrap((current) => current ? { ...current, workspace: { ...current.workspace, ...updated } } : current)} />
              </div>
            </div>
          )}
        </main>
      </div>

      {(activeModal === 'createRoom' || activeModal === 'createMeeting') && bootstrap && <DiscussionDialog
        kind={activeModal === 'createMeeting' ? 'meeting' : 'room'} workspace={bootstrap.workspace.root}
        room={activeRoom} members={bootstrap.members} onClose={() => setActiveModal(null)}
        onCreated={handleDiscussionCreated} onBusy={(busy) => { discussionBusy.current = busy; }} />}

      {activeModal === 'managedRequest' && bootstrap && <ManagedRequestDialog workspace={bootstrap.workspace.root}
        roomId={managedRequestRoomId}
        team={bootstrap.workspace.managedTeam || null} members={bootstrap.members}
        onClose={() => setActiveModal(null)} onSettings={() => { setReturnToManagedRequest(managedRequestRoomId); setActiveModal(null); handleTabChange('settings'); }}
        onCreated={handleTaskCreated} onBusy={(busy) => { taskCreateBusy.current = busy; }} />}

      {activeModal === 'createTask' && bootstrap && <TaskCreateDialog
        key={taskCreateSeed.sourceSessionId || 'new-task'} workspaceRoot={bootstrap.workspace.root}
        workspacesPath={bootstrap.workspace.workspacesPath} members={bootstrap.members} rooms={bootstrap.rooms}
        seed={taskCreateSeed} defaultRoomId={activeRoom?.kind === 'team' && !activeRoom.archivedAt ? activeRoom.id : 'team'}
        onClose={() => setActiveModal(null)} onCreated={handleTaskCreated} onBusyChange={(busy) => { taskCreateBusy.current = busy; }}
        onOpenMembers={() => { setReturnToTaskCreation(true); setActiveModal(null); setActiveTab('members'); navigate('members', { replace: true }); }} />}

      {/* 弹窗 4: 任务详情与评审弹窗 */}
      {activeModal === 'taskDetail' && selectedTaskId && (() => {
        const task = getTask(selectedTaskId);
        if (!task) return null;
        const assignee = getMember(task.assigneeId);
        const reviewer = getMember(task.reviewerId);
        const progress = taskProgress?.taskId === task.id ? taskProgress : null;
        const taskPending = hasTaskBusy(taskBusy[task.id]) || Boolean(taskNeedsRefresh[task.id]);
        const assignmentPending = !assignmentDrafts[task.id]?.ready || assignmentDrafts[task.id]?.dirty;
        const taskNotice = taskNotices[task.id];
        const assistanceNeedsAnswer = needsAssistanceAnswer(task, progress);
        const assistanceBlocksContinue = assistanceNeedsAnswer && !reviseFeedback.trim();
        const isReviewStatus = task.status === 'review' && !task.archivedAt;
        const isGatePassed = task.gate.status === 'passed';
        const isGateFailedOrStale =
          ['failed', 'stale', 'pending'].includes(task.gate.status);
        const acceptIssue = acceptanceIssue(task, acceptNote, acknowledgeMissingGate);

        return renderInspection(
          <div className="modal-overlay" onClick={closeTaskInspector}>
            <div className="modal-content modal-lg" data-task-detail={task.id} onClick={(e) => e.stopPropagation()}
              onFocusCapture={(event) => {
                if (event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLInputElement && event.target.type === 'text')) {
                  lastTaskInput.current = { taskId: task.id, input: event.target };
                }
              }}>
              <div className="modal-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
                  <span className="modal-title" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{task.title}</span>
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: 'var(--bg-canvas)',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    {task.archivedAt ? '已归档 · ' : ''}{taskStatusNames[task.status]}
                  </span>
                </div>
                <button
                  className="btn btn-sm btn-secondary btn-icon-only"
                  aria-label="关闭任务详情"
                  title="关闭任务详情"
                  onClick={closeTaskInspector}
                >
                  <X size={14} />
                </button>
              </div>

              <nav className="task-section-nav" aria-label="任务详情章节">
                {[['plan', '计划与求助'], ['materials', '材料'], ['artifacts', '成果'], ['team', '分工'], ['acceptance', '验收']].map(([section, label]) =>
                  <button key={section} type="button" onClick={() => setTaskSection({ taskId: task.id, section })}>{label}</button>)}
              </nav>
              {taskNotice && <div className="task-operation-feedback" data-tone={taskNotice.tone}
                role={taskNotice.tone === 'error' ? 'alert' : 'status'}>
                {taskNotice.tone === 'success' ? <Check size={15} /> : <AlertCircle size={15} />}
                <span>{taskNotice.text}</span>
                {taskNotice.cleanup && <button type="button" className="btn btn-sm btn-secondary" disabled={taskPending}
                  onClick={() => { void cleanupTaskDraft(task.id); }}>重试清理草稿</button>}
                {taskNotice.tone === 'error' && <button type="button" className="btn btn-sm btn-secondary"
                  disabled={hasTaskBusy(taskBusy[task.id])} onClick={() => { void checkTaskStatus(task.id); }}>刷新任务状态</button>}
              </div>}
              <div className="modal-body">
                <section className="task-files" data-task-section="artifacts">
                  <div className="form-label">交付文件</div>
                  {!(bootstrap?.artifacts || []).some((artifact) => artifact.taskId === task.id) && <p className="task-inspector-empty">尚无成果文件。</p>}
                  {(bootstrap?.artifacts || []).filter((artifact) => artifact.taskId === task.id).map((artifact) => <div className="artifact-row" key={artifact.id}>
                    {canPreview(artifact) ? <button className="file-link" onClick={() => openArtifact(artifact, true)}>
                      <BookOpen size={15} /><span>{artifact.name}</span></button> : <span>{artifact.name}</span>}
                    <small>{formatFileSize(artifact.size)}</small>
                    <ArtifactDownload artifact={artifact} compact className="btn btn-secondary btn-icon-only" />
                  </div>)}
                </section>
                {task.sourceContext && <div>
                  <div className="form-label">接力来源</div>
                  <div>{task.sourceContext.title}</div>
                  <small>独立任务 · 原会话保留写入权</small>
                </div>}
                <fieldset data-task-section="materials" disabled={taskPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                  onChangeCapture={(event) => { if (isTaskBusy(task.id) && !taskBusyRef.current[task.id]?.materials) { event.preventDefault(); event.stopPropagation(); } }}>
                  <TaskMaterials key={`materials-${task.id}`} task={task} onChanged={loadBootstrap} onBusyChange={reportMaterialsBusy} />
                </fieldset>
                <details open={task.status === 'backlog'}>
                  <summary className="form-label">任务目标</summary>
                  <div style={{ color: 'var(--text-primary)', fontSize: '13px', marginTop: '4px', overflowWrap: 'anywhere' }}>
                    {task.objective}
                  </div>
                </details>
                {task.summary && <section><div className="form-label">{task.status === 'done' ? '交付摘要' : '最新结果'}</div><p className="task-summary">{task.summary}</p></section>}
                <div data-task-section="plan"><TaskCoordination key={`coordination-${task.id}`} workspaceRoot={bootstrap?.workspace.root || ''} task={task} members={bootstrap?.members || []} data={progress}
                  loading={taskProgressLoading} disabled={taskPending} error={taskProgressError} refresh={loadTaskProgress}
                  onChanged={refreshTask} onOpenRun={openRunDetail} onBusyChange={reportCoordinationBusy} /></div>
                <div data-task-section="team"><TaskAssignment key={`assignment-${task.id}`} task={task} members={bootstrap?.members || []}
                  workspaceRoot={bootstrap?.workspace.root || ''} contextId={task.coordination?.planId ? undefined : latestImplementation}
                  canReassign={progress && !taskProgressError ? progress.canReassign : undefined} reviewerExcludedIds={progress?.reviewerExcludedIds || []}
                  disabled={taskPending || taskProgressLoading || Boolean(taskProgressError)} onChanged={async updated => { applyTaskResult(updated); await refreshTask(); }}
                  onBusyChange={reportAssignmentBusy} onDraftStateChange={reportAssignmentDraft} /></div>

                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  <div>
                    <span className="form-label">{task.executionMode === 'delegated' ? '负责人: ' : '执行人: '}</span>
                    <span>{assignee ? `${assignee.name} (@${assignee.handle})` : '未指定'}</span>
                  </div>
                  <div>
                    <span className="form-label">评审人: </span>
                    <span>{reviewer ? `${reviewer.name} (@${reviewer.handle})` : '未指定'}</span>
                  </div>
                  <div>
                    <span className="form-label">自动修复次数: </span>
                    <span>{task.repairCount}</span>
                  </div>
                  <div>
                    <span className="form-label">门禁验证状态: </span>
                    {renderGateBadge(task.gate)}
                  </div>
                </div>

                {/* 需求清单 (非模拟勾选框，真实列表) */}
                <div>
                  <div className="form-label">需求清单 (Checklist)</div>
                  {task.requirements && task.requirements.length > 0 ? (
                    <ul
                      style={{
                        marginTop: '6px',
                        paddingLeft: '18px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                      }}
                    >
                      {task.requirements.map((req, idx) => (
                        <li key={idx} style={{ color: 'var(--text-primary)', fontSize: '12.5px' }}>
                          {req}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>无细分需求要求</div>
                  )}
                </div>

                {/* 门禁详情 */}
                {task.verification && (
                  <div
                    style={{
                      background: 'var(--bg-surface-subtle)',
                      padding: '10px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-color)',
                    }}
                  >
                    <div className="form-label">门禁验证指令</div>
                    <div className="mono-path" style={{ marginTop: '4px' }}>
                      {task.verification.executable} {task.verification.args.join(' ')}
                    </div>
                    {task.gate.summary && (
                      <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        验证报告: {task.gate.summary} (退出码: {task.gate.exitCode ?? '无'})
                      </div>
                    )}
                  </div>
                )}

                {/* 关联讨论室入口 */}
                {task.roomId && !task.archivedAt && (
                  <div>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => {
                        setActiveRoomId(task.roomId);
                        setActiveTab('rooms');
                        navigate('rooms', { roomId: task.roomId, replace: true });
                        setActiveModal(null);
                      }}
                    >
                      <MessagesSquare size={13} />
                      <span>打开所属频道</span>
                    </button>
                  </div>
                )}

                <div data-task-section="acceptance">
                  <div className="form-label">整体验收</div>
                  <p className="text-muted">机器检查：{renderGateBadge(task.gate)} · 独立评审：{task.reviewerId ? task.reviewVerdict === 'approve' ? '已通过' : '尚未通过' : '未指定'}</p>
                  {task.status === 'done' && task.acceptanceNote && <div className="task-acceptance-record">
                    <div className="form-label">已记录的验收意见</div>
                    <p>{task.acceptanceNote}</p>
                    {task.acceptedAt && <small className="text-muted">验收时间：{new Date(task.acceptedAt).toLocaleString('zh-CN')}</small>}
                  </div>}
                </div>
                {(task.status === 'blocked' || task.status === 'review') && <div className="task-draft-notice">
                  {(revisionDraft.error || acceptanceDraft.error) ? <div className="error-banner" role="alert">
                    <AlertCircle size={14} /><span>{revisionDraft.error || acceptanceDraft.error}</span>
                    <button className="btn btn-sm btn-secondary" onClick={() => { void revisionDraft.retry(); void acceptanceDraft.retry(); }}>重试保存草稿</button>
                  </div> : <span className="draft-status" role="status">{revisionDraft.saving || acceptanceDraft.saving ? '正在保存文字草稿…'
                    : !revisionDraft.loaded || !acceptanceDraft.loaded ? '正在恢复文字草稿…' : '文字草稿已保存，查看日志或文件后可以继续填写'}</span>}
                </div>}
                {task.status === 'blocked' && !task.archivedAt && <div className="form-group">
                  <label className="form-label" htmlFor="blocked-task-feedback">继续任务前的纠正要求（可选）</label>
                  <textarea id="blocked-task-feedback" className="form-textarea" rows={3} maxLength={6000}
                    placeholder="补充失败原因、已修复的问题或新的约束，负责人会据此重新安排工作。"
                    data-testid="revise-feedback" disabled={taskPending || !revisionDraft.loaded}
                    value={reviseFeedback} onChange={(event) => setReviseFeedback(event.target.value)} />
                  <div className="text-muted">{assistanceNeedsAnswer
                    ? '当前协作问题还缺答复。请先在上方保存答复，或填写纠正要求后带反馈继续。'
                    : '填写后将携带反馈继续；留空则按已有任务上下文重试。'}</div>
                </div>}

                {/* 评审操作区域 (仅限 review 状态) */}
                {isReviewStatus && (
                  <div
                    style={{
                      borderTop: '1px solid var(--border-color)',
                      paddingTop: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                    }}
                  >
                    <div className="form-label" style={{ color: 'var(--primary-teal)' }}>
                      任务验收与评审决策
                    </div>

                    {isGateFailedOrStale && (
                      <div className="error-banner">
                        <AlertCircle size={14} />
                        <span>机器检查尚未通过或已失效，需完成检查后验收。</span>
                      </div>
                    )}

                    {!isGatePassed && !isGateFailedOrStale && (
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          cursor: 'pointer',
                          fontSize: '12.5px',
                          color: 'var(--warning)',
                        }}
                      >
                        <input
                          type="checkbox"
                          data-testid="ack-missing-gate" checked={acknowledgeMissingGate}
                          disabled={taskPending}
                          onChange={(e) => setAcknowledgeMissingGate(e.target.checked)}
                        />
                        <span>门禁尚未通过，我已人工复核并显式确认接受遗漏的自动化测试门禁</span>
                      </label>
                    )}

                    <div className="form-group">
                      <label className="form-label" htmlFor="task-accept-note">验收备注（必填，最多 2000 字）</label>
                      <input
                        id="task-accept-note" type="text" data-testid="accept-note" maxLength={2000} required
                        className="form-input"
                        placeholder="输入验收意见..."
                        value={acceptNote}
                        disabled={taskPending || !acceptanceDraft.loaded}
                        onChange={(e) => setAcceptNote(e.target.value)}
                      />
                    </div>

                    {(showReviseInput || Boolean(reviseFeedback)) && (
                      <div className="form-group">
                        <label className="form-label">修改要求与具体反馈</label>
                        <textarea
                          rows={3} data-testid="revise-feedback" maxLength={6000}
                          className="form-textarea"
                          placeholder="清晰说明需要修改或补充的内容..."
                          value={reviseFeedback}
                          disabled={taskPending || !revisionDraft.loaded}
                          onChange={(e) => setReviseFeedback(e.target.value)}
                        />
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      {!showReviseInput && !reviseFeedback ? (
                        <button
                          className="btn btn-secondary"
                          disabled={taskPending}
                          onClick={() => setShowReviseInput(true)}
                        >
                          <RotateCcw size={13} />
                          <span>要求修改</span>
                        </button>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          onClick={() => handleReviseTask(task)}
                          disabled={taskPending || !revisionDraft.loaded || !reviseFeedback.trim()}
                        >
                          <span>{taskBusy[task.id]?.revise ? '正在提交修改要求' : '提交修改要求'}</span>
                        </button>
                      )}

                      <button
                        className="btn btn-primary"
                        onClick={() => handleAcceptTask(task)}
                        disabled={taskPending || !acceptanceDraft.loaded || Boolean(acceptIssue)}
                        title={acceptIssue || '记录验收意见并完成任务'}
                      >
                        <Check size={13} />
                        <span>{taskBusy[task.id]?.accept ? '正在提交验收' : '验收通过'}</span>
                      </button>
                    </div>
                    {acceptIssue && <p className="text-muted" role="status">{acceptIssue}</p>}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                {['backlog', 'blocked'].includes(task.status) && !task.archivedAt && (
                  <>
                  {assignmentPending && <div className="task-assignment-reminder" role="status">
                    {!assignmentDrafts[task.id]?.ready ? '正在恢复分工草稿…' : <>分工调整尚未应用，请先保存或恢复当前分工。
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setTaskSection({ taskId: task.id, section: 'team' })}>查看待保存分工</button></>}
                  </div>}
                  <button
                    className="btn btn-primary"
                    disabled={taskPending || taskProgressLoading || !progress || progress.active || Boolean(taskProgressError) || assistanceBlocksContinue || assignmentPending}
                    title={assignmentPending ? '请先保存或恢复调整中的分工' : assistanceBlocksContinue ? '请先保存协助答复，或填写纠正要求后继续' : undefined}
                    onClick={() => handleStartTask(task.id, task.status === 'blocked' ? reviseFeedback : '')}
                  >
                    {task.status === 'blocked' ? <RotateCcw size={13} /> : <Play size={13} />}
                    <span>{taskBusy[task.id]?.start ? '正在启动' : progress?.active ? '等待成员停止' : task.status === 'blocked' ? (reviseFeedback.trim() ? '带反馈继续' : '继续任务') : '启动任务'}</span>
                  </button>
                  </>
                )}
                {task.status !== 'done' && task.status !== 'cancelled' && !task.archivedAt && (
                  <button
                    className="btn btn-danger"
                    disabled={taskPending}
                    onClick={() => promptCancelTask(task.id)}
                  >
                    <Square size={13} />
                    <span>取消任务</span>
                  </button>
                )}
                {task.status !== 'running' && <button className="btn btn-secondary" disabled={archiveBusy || taskPending || Boolean(progress?.active)}
                  onClick={() => handleArchive('tasks', task.id, !task.archivedAt)}>
                  {task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  <span>{task.archivedAt ? '恢复任务' : '归档任务'}</span>
                </button>}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeTaskInspector}
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {activeModal === 'artifactPreview' && previewArtifact && renderInspection(<ArtifactPreview artifact={previewArtifact}
        status={getTask(previewArtifact.taskId)?.status}
        onClose={() => setActiveModal(previewReturnTask ? 'taskDetail' : null)} />)}

      {/* 弹窗 5: 成员编辑/创建 */}
      {(activeModal === 'memberEdit' || activeModal === 'memberCreate') && (
        <div className="modal-overlay" onClick={closeMemberModal}>
          <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {activeModal === 'memberEdit' ? '编辑代理配置' : '添加代理成员'}
              </span>
              <button
                className="btn btn-sm btn-secondary btn-icon-only"
                disabled={memberSaving} aria-label="关闭成员配置"
                onClick={closeMemberModal}
              >
                <X size={14} />
              </button>
            </div>
            <form onSubmit={handleSaveMember} onChange={() => setMemberError('')}>
              <fieldset className="modal-body" disabled={memberSaving} style={{ border: 0, margin: 0, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">成员名称</label>
                    <input
                      type="text"
                      required
                      maxLength={60}
                      className="form-input"
                      placeholder="例如: 代码构建员"
                      value={memberForm.name}
                      onChange={(e) => setMemberForm({ ...memberForm, name: e.target.value })}
                    />
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">成员 Handle (英文代号)</label>
                    <input
                      type="text"
                      required
                      pattern="[a-z](?:[a-z0-9]|-){1,39}" maxLength={40} title="以小写字母开头，使用 2–40 个小写字母、数字或连字符"
                      className="form-input form-input-mono"
                      placeholder="例如: builder-cli"
                      value={memberForm.handle}
                      onChange={(e) => setMemberForm({ ...memberForm, handle: e.target.value })}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">预设提供方 (Provider)</label>
                    <select
                      className="form-select"
                      value={memberForm.provider}
                      onChange={(e) =>
                        setMemberForm({
                          ...memberForm,
                          provider: e.target.value as Member['provider'],
                          model: '',
                        })
                      }
                    >
                      <option value="antigravity">antigravity</option>
                      <option value="dsh">dsh (ACP)</option>
                      <option value="claude">claude</option>
                      <option value="gemini">gemini</option>
                      <option value="codex">codex</option>
                      <option value="opencode">opencode</option>
                      <option value="custom">custom (自定义)</option>
                    </select>
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">角色分工 (Role)</label>
                    <select
                      className="form-select"
                      value={memberForm.role}
                      onChange={(e) =>
                        setMemberForm({
                          ...memberForm,
                          role: e.target.value as Member['role'],
                        })
                      }
                    >
                      <option value="builder">构建者 (Builder)</option>
                      <option value="reviewer">评审者 (Reviewer)</option>
                      <option value="researcher">调研者 (Researcher)</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="member-skills">擅长技能与适用工作</label>
                  <textarea id="member-skills" className="form-input" rows={4} maxLength={2000}
                    placeholder="例如：React / TypeScript 界面开发；擅长表单与交互排错；适合承担前端实现和代码评审。"
                    value={memberForm.skills} onChange={(event) => setMemberForm({ ...memberForm, skills: event.target.value })} />
                  <div className="text-muted">可填写多行，最多 2000 字符。成员会参考这些描述选择协作对象；填写描述不会安装技能或改变权限。</div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <ModelChoice key={`${selectedMember?.id || 'new'}:${memberForm.provider}:${selectedMember?.runtime?.fingerprint || 'unprobed'}`} value={memberForm.model}
                      onChange={(model) => setMemberForm({ ...memberForm, model })}
                      models={selectedMember?.provider === memberForm.provider && (selectedMember.dshConfigProfile || 'auto') === memberForm.dshConfigProfile
                        ? selectedMember.runtime?.models : []}
                      defaultModel={selectedMember?.provider === memberForm.provider && (selectedMember.dshConfigProfile || 'auto') === memberForm.dshConfigProfile
                        ? selectedMember.runtime?.diagnostics?.defaultModel : null} />
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">可执行文件路径 (Executable, 留空自动发现)</label>
                    <input
                      type="text"
                      className="form-input form-input-mono"
                      placeholder="C:\...\agy.exe"
                      value={memberForm.executable}
                      onChange={(e) =>
                        setMemberForm({ ...memberForm, executable: e.target.value })
                      }
                    />
                  </div>
                </div>

                {memberForm.provider === 'dsh' && <div className="form-group">
                  <label className="form-label" htmlFor="dsh-config-profile">DSH 模型配置来源</label>
                  <select id="dsh-config-profile" className="form-select" value={memberForm.dshConfigProfile}
                    onChange={(event) => setMemberForm({ ...memberForm, dshConfigProfile: event.target.value as NonNullable<Member['dshConfigProfile']> })}>
                    <option value="auto">自动选择官方配置</option>
                    <option value="desktop">DSH 桌面端</option>
                    <option value="web">DSH Web</option>
                    <option value="acp">DSH ACP</option>
                  </select>
                </div>}
                <div className="form-group">
                  <label className="form-label">前置参数（JSON 数组）</label>
                  <input
                    type="text"
                    className="form-input form-input-mono"
                    placeholder='["C:\\path with spaces\\cli.js"]'
                    value={memberForm.prefixArgs}
                    onChange={(e) =>
                      setMemberForm({ ...memberForm, prefixArgs: e.target.value })
                    }
                  />
                </div>

                {memberForm.provider === 'custom' && (
                  <div className="form-group">
                    <label className="form-label">
                      自定义启动参数 (JSON 数组格式，使用 {'{prompt}'} 作为指令占位符)
                    </label>
                    <input
                      type="text"
                      className="form-input form-input-mono"
                      placeholder='例如: ["--arg", "val", "-m", "{prompt}"]'
                      value={memberForm.customArgs}
                      onChange={(e) =>
                        setMemberForm({ ...memberForm, customArgs: e.target.value })
                      }
                    />
                  </div>
                )}

                <div style={{ display: 'flex', gap: '12px' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">输入传递模式 (Input Mode)</label>
                    <select
                      className="form-select"
                      value={memberForm.inputMode}
                      onChange={(e) =>
                        setMemberForm({
                          ...memberForm,
                          inputMode: e.target.value as 'argument' | 'stdin',
                        })
                      }
                    >
                      <option value="argument">命令行参数 (Argument)</option>
                      <option value="stdin">标准输入 (Stdin)</option>
                    </select>
                  </div>

                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">权限级别 (Permission)</label>
                    <select
                      className="form-select"
                      value={memberForm.permission}
                      onChange={(e) =>
                        setMemberForm({
                          ...memberForm,
                          permission: e.target.value as 'plan' | 'edit',
                        })
                      }
                    >
                      <option value="edit">编辑代码与文件 (edit)</option>
                      <option value="plan">仅方案规划 (plan)</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={memberForm.enabled}
                      onChange={(e) =>
                        setMemberForm({ ...memberForm, enabled: e.target.checked })
                      }
                    />
                    <span className="form-label" style={{ marginBottom: 0 }}>
                      启用该成员参与协作
                    </span>
                  </label>
                </div>
              </fieldset>

              {memberError && <div className="error-banner" role="alert">{memberError}</div>}
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={memberSaving}
                  onClick={closeMemberModal}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={memberSaving}>
                  {memberSaving ? '正在保存…' : '保存成员配置'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {discardMemberOpen && <ActionConfirmDialog
        title="放弃未保存的成员配置？"
        message="本次修改尚未保存。放弃后需要重新填写；已保存的成员配置不会改变。"
        confirmText="放弃修改"
        returnText="继续编辑"
        busy={false}
        disabled={false}
        error=""
        onConfirm={discardMemberChanges}
        onClose={() => setDiscardMemberOpen(false)} />}

      {/* 弹窗 6: Run 日志检查详情 */}
      {activeModal === 'runDetail' && !selectedRunData && renderInspection(<div className="modal-overlay">
        <div className="modal-content" role="dialog" aria-label="正在加载作业日志">
          <div className="modal-header"><span className="modal-title">作业日志</span>
            <button className="btn btn-sm btn-secondary" onClick={() => setActiveModal(runReturnTask ? 'taskDetail' : null)}>
              {runReturnTask ? '返回任务' : '关闭日志'}
            </button>
          </div>
          <div className="modal-body">{runLogError
            ? <div className="error-banner" role="alert"><span>{runLogError}</span>
              <button className="btn btn-sm btn-secondary" onClick={() => void retryRunDetail()}>重试加载</button></div>
            : <p role="status">正在加载作业日志…</p>}</div>
        </div>
      </div>)}
      {activeModal === 'runDetail' && selectedRunData && renderInspection(
        <div className="modal-overlay" onClick={() => setActiveModal(runReturnTask ? 'taskDetail' : null)}>
          <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Terminal size={16} />
                <span className="modal-title">
                  作业执行日志 · {runStageName(selectedRunData.run.stage)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {runReturnTask && <button className="btn btn-sm btn-secondary" onClick={() => setActiveModal('taskDetail')}>返回任务</button>}
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={async () => {
                    if (selectedRunId) {
                      const sequence = ++runDetailsSequence.current;
                      try {
                        const updated = await api.getRunDetails(selectedRunId);
                        if (sequence === runDetailsSequence.current) { setSelectedRunData(updated); setRunLogError(''); }
                      } catch (reason) {
                        if (sequence === runDetailsSequence.current) setRunLogError(reason instanceof Error ? reason.message : '日志刷新失败');
                      }
                    }
                  }}
                  title="刷新日志"
                >
                  <RefreshCw size={12} />
                  <span>刷新</span>
                </button>
                <button
                  className="btn btn-sm btn-secondary btn-icon-only"
                  aria-label="关闭作业日志"
                  onClick={() => setActiveModal(runReturnTask ? 'taskDetail' : null)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="modal-body">
              <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
                <div>
                  <strong>执行状态: </strong>
                  <span>{runStatusLabels[selectedRunData.run.status]}</span>
                </div>
                <div>
                  <strong>退出代码: </strong>
                  <span>{selectedRunData.run.exitCode ?? (selectedRunData.run.status === 'queued' ? '尚未启动' : selectedRunData.run.status === 'running' ? '尚未退出' : '未提供')}</span>
                </div>
                <div>
                  <strong>跳数/轮次: </strong>
                  <span>{selectedRunData.run.hop}</span>
                </div>
                <div>
                  <strong>创建时间: </strong>
                  <span>{new Date(selectedRunData.run.createdAt).toLocaleTimeString()}</span>
                </div>
              </div>

              {selectedRunData.run.status === 'queued' && (
                <div className="run-wait-notice" role="status" data-run-state="queued">
                  <Clock3 size={15} />
                  <div>
                    <strong>排队等待启动</strong>
                    <span>{selectedRunData.waitReason || '已进入队列，等待调度启动'}</span>
                  </div>
                </div>
              )}
              {selectedRunData.run.status === 'running' && (
                <div className="run-wait-notice" role="status" data-run-state="running">
                  <Activity size={15} />
                  <div>
                    <strong>正在执行</strong>
                    <span>终端输出每 2 秒自动刷新；离开此页不会终止作业。</span>
                  </div>
                </div>
              )}
              {runLogError && <div className="error-banner" role="alert">{runLogError}（保留上次日志，可点击刷新重试）</div>}
              {selectedRunData.run.warnings?.map((warning, index) => (
                <div className="run-warning" key={index}><AlertCircle size={15} /><span>{warning}</span></div>
              ))}
              {(selectedRunData.run.runtime || selectedRunData.run.riskFlags.length > 0 || ['failed', 'blocked', 'cancelled', 'interrupted'].includes(selectedRunData.run.status)) && <RunDiagnostics run={selectedRunData.run} />}
              {selectedRunData.run.error && (
                <div className="error-banner">
                  <AlertCircle size={14} />
                  <span>{selectedRunData.run.error}</span>
                </div>
              )}

              <div>
                <div className="form-label">终端实时输出 (Log Tail)</div>
                <div className="log-terminal" data-empty={!selectedRunData.logTail || undefined}>
                  {selectedRunData.logTail || (selectedRunData.run.status === 'queued'
                    ? '作业尚未启动，因此还没有终端输出。恢复或完成调度后，这里会自动显示输出。'
                    : selectedRunData.run.status === 'running'
                      ? '成员正在准备首段输出，页面会自动刷新。'
                      : '本次作业没有产生终端日志。')}
                </div>
              </div>

              {selectedRunData.result && (
                <div>
                  <div className="form-label">返回结果摘要</div>
                  <pre
                    style={{
                      background: 'var(--bg-surface-subtle)',
                      border: '1px solid var(--border-color)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '12px',
                    }}
                  >
                    {selectedRunData.result}
                  </pre>
                </div>
              )}
            </div>

            <div className="modal-footer">
              {(selectedRunData.run.status === 'running' ||
                selectedRunData.run.status === 'queued') && (
                <button
                  className="btn btn-danger"
                  disabled={hasTaskBusy(taskBusy[selectedRunData.run.taskId || selectedRunData.run.contextTaskId || ''])}
                  onClick={() => promptCancelRun(selectedRunData.run.id)}
                >
                  <Square size={13} />
                  <span>终止执行</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setActiveModal(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 7: 破坏性操作二次确认 */}
      {confirmConfig && <ActionConfirmDialog title={confirmConfig.title} message={confirmConfig.message}
        confirmText={confirmConfig.confirmText} returnText={confirmConfig.returnText} busy={confirmBusy} error={confirmError}
        disabled={isTaskBusy(confirmConfig.taskId)} onConfirm={() => { void confirmCancellation(); }}
        onClose={() => { if (!confirmActionLock.current) { setConfirmConfig(null); setConfirmError(''); } }} />}
    </div>
    {desktopLeaving && <div className="desktop-leave-overlay" role="status" aria-live="polite">
      <div>正在保存当前内容…<span>保存完成后继续退出或切换工作目录。</span></div>
    </div>}
    </>
  );
}
