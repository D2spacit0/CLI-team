import React, { useState } from 'react';
import { fixtureScenarios, type FixtureScenario } from './fixtureData';
import { RoomList } from '../rooms/RoomList';
import { RoomHeader } from '../rooms/RoomHeader';
import { RoomComposer } from '../rooms/RoomComposer';
import ChatTimeline from '../ChatTimeline';
import { TaskRelay } from '../inspector/TaskRelay';
import { InspectorPanel } from '../inspector/InspectorPanel';
import type { Artifact, Run, Task } from '../../types';
import {
  FileText,
  CheckCircle,
  AlertTriangle,
  RotateCcw,
  Send,
  X,
  Play,
  HelpCircle,
  Eye,
} from 'lucide-react';

export function FixtureWorkbench() {
  const [scenarioId, setScenarioId] = useState(fixtureScenarios[0].id);
  const currentBase = fixtureScenarios.find((s) => s.id === scenarioId) || fixtureScenarios[0];

  // 场景工作副本（支持交互时动态更新状态）
  const [activeScenario, setActiveScenario] = useState<FixtureScenario>(currentBase);

  // 当切换场景下拉时重置工作副本
  const handleScenarioChange = (id: string) => {
    setScenarioId(id);
    const found = fixtureScenarios.find((s) => s.id === id) || fixtureScenarios[0];
    setActiveScenario(JSON.parse(JSON.stringify(found)));
    setComposerBody('');
    setRecipientIds([]);
    setSelectedTaskId(found.tasks[0]?.id || null);
    setSelectedRun(null);
    setPreviewArtifact(null);
    setInspectorDockOpen(false);
  };

  const [composerBody, setComposerBody] = useState('');
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [analysisOnly, setAnalysisOnly] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);

  // 选中对象与检查抽屉
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    activeScenario.tasks[0]?.id || null
  );
  const [selectedSection, setSelectedSection] = useState<string>('plan');
  const [inspectorDockOpen, setInspectorDockOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);

  // 表单模拟互动状态
  const [answerInput, setAnswerInput] = useState('');
  const [simulatedFeedback, setSimulatedFeedback] = useState<string | null>(null);

  const focusTask =
    activeScenario.tasks.find((t) => t.id === selectedTaskId) ||
    activeScenario.tasks[0];

  // 模拟材料重试交互
  const handleRetryMaterial = () => {
    if (!focusTask) return;
    setActiveScenario((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `msg-retry-${Date.now()}`,
          roomId: prev.room.id,
          senderId: 'system',
          senderName: '材料系统',
          body: '【重试成功】data-large.csv 已重新校验哈希匹配，所有材料已就绪，可启动任务。',
          kind: 'system',
          recipientIds: [],
          createdAt: new Date().toISOString(),
        },
      ],
      tasks: prev.tasks.map((t) =>
        t.id === focusTask.id ? { ...t, summary: '材料已完整就绪，等待首次启动' } : t
      ),
    }));
    setSimulatedFeedback('材料重试成功！已补全失败分块。');
  };

  // 模拟业务求助人工答复交互
  const handleSubmitAnswer = () => {
    if (!answerInput.trim()) return;
    setActiveScenario((prev) => {
      const updatedSteps = prev.progress?.coordination?.steps.map((s) =>
        s.key === 'step-2' ? { ...s, status: 'running' as const, helpId: undefined } : s
      );
      return {
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: `msg-ans-${Date.now()}`,
            roomId: prev.room.id,
            senderId: 'user',
            senderName: '你',
            body: `【求助答复已提供】${answerInput}`,
            kind: 'user',
            recipientIds: ['member-worker'],
            taskId: focusTask?.id,
            createdAt: new Date().toISOString(),
          },
        ],
        tasks: prev.tasks.map((t) =>
          t.id === focusTask?.id
            ? { ...t, status: 'running' as const, summary: '求助已解答，步骤 2 继续执行' }
            : t
        ),
        progress: prev.progress
          ? {
              ...prev.progress,
              coordination: prev.progress.coordination
                ? {
                    ...prev.progress.coordination,
                    phase: 'working',
                    steps: updatedSteps || prev.progress.coordination.steps,
                  }
                : undefined,
              assistance: (prev.progress.assistance || []).map((h) => ({
                ...h,
                status: 'answered' as const,
                answer: answerInput,
                answeredAt: new Date().toISOString(),
              })),
            }
          : null,
      };
    });
    setAnswerInput('');
    setSimulatedFeedback('答复已提交！协作任务解除阻断继续执行。');
  };

  // 模拟重新执行机器验收
  const handleRerunGate = () => {
    setActiveScenario((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `msg-rerun-${Date.now()}`,
          roomId: prev.room.id,
          senderId: 'system',
          senderName: '验证系统',
          body: '【机器验证通过】执行 npm test 退出码 0，最新产物验证通过。',
          kind: 'system',
          recipientIds: [],
          taskId: focusTask?.id,
          createdAt: new Date().toISOString(),
        },
      ],
      tasks: prev.tasks.map((t) =>
        t.id === focusTask?.id
          ? {
              ...t,
              gate: {
                status: 'passed' as const,
                summary: '最新产物测试通过 (exitCode: 0)',
                exitCode: 0,
                evidenceId: `ev-${Date.now()}`,
              },
            }
          : t
      ),
    }));
    setSimulatedFeedback('机器验证重新执行完成，门禁已通过！');
  };

  return (
    <div
      className="fixture-workbench-wrapper"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* 显式开发预览横幅 */}
      <div className="fixture-banner" role="status">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="fixture-badge">开发预览 / 演示模式</span>
          <span>{activeScenario.description}</span>
          {simulatedFeedback && (
            <span
              style={{
                marginLeft: '8px',
                color: 'var(--wb-success)',
                fontSize: '11px',
                fontWeight: 600,
              }}
            >
              ✓ {simulatedFeedback}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label htmlFor="fixture-scenario-select" style={{ fontSize: '11px' }}>
            选择演示场景:
          </label>
          <select
            id="fixture-scenario-select"
            value={scenarioId}
            onChange={(e) => handleScenarioChange(e.target.value)}
            style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '4px' }}
          >
            {fixtureScenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 工作台结构 */}
      <div className="discussion-view room-workbench" style={{ flex: 1, minHeight: 0 }}>
        <RoomList
          rooms={[activeScenario.room]}
          roomId={activeScenario.room.id}
          tasks={activeScenario.tasks}
          onSelectRoom={() => {}}
          onCreateRoom={() => {}}
          onCreateTask={() => {}}
        />

        <section className="chat-main-area" aria-label="聊天室工作台">
          <RoomHeader
            room={activeScenario.room}
            rooms={[activeScenario.room]}
            roomId={activeScenario.room.id}
            roomTasks={activeScenario.tasks}
            loading={false}
            contextOpen={contextOpen}
            onRoomChange={() => {}}
            onRefresh={() => {}}
            onMeeting={() => {}}
            onToggleContext={() => setContextOpen((v) => !v)}
            onCreateRoom={() => {}}
          />

          {focusTask && (
            <div className="room-task-scope">
              <div
                className="room-task-row"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setSelectedTaskId(focusTask.id);
                  setInspectorDockOpen(true);
                }}
                title="点击展开任务检查详情"
              >
                <span className={`task-state-dot state-${focusTask.status}`} />
                <span className="room-task-title">{focusTask.title}</span>
                <small>{focusTask.status}</small>
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--wb-accent)' }}>
                  展开检查区 →
                </span>
              </div>
              <TaskRelay
                task={focusTask}
                progress={activeScenario.progress}
                members={activeScenario.members}
                onOpen={() => {
                  setSelectedTaskId(focusTask.id);
                  setInspectorDockOpen(true);
                }}
              />
            </div>
          )}

          <ChatTimeline
            scope={`fixture:${activeScenario.room.id}`}
            messages={activeScenario.messages}
            members={activeScenario.members}
            tasks={activeScenario.tasks}
            runs={activeScenario.runs}
            loading={false}
            error={null}
            onRefresh={() => {}}
            onOpenTask={(id) => {
              setSelectedTaskId(id);
              setInspectorDockOpen(true);
            }}
            onOpenRun={(id) => {
              const r = activeScenario.runs.find((run) => run.id === id);
              if (r) setSelectedRun(r);
            }}
          />

          <RoomComposer
            room={activeScenario.room}
            roomTasks={activeScenario.tasks}
            members={activeScenario.members}
            composer={{
              body: composerBody,
              recipientIds,
              taskId: focusTask?.id || '',
              analysisOnly,
              sending: false,
              loaded: true,
              saving: false,
              draftError: '',
              error: '',
              onBody: setComposerBody,
              onRecipients: setRecipientIds,
              onTask: () => {},
              onClearTask: () => {},
              onAnalysis: setAnalysisOnly,
              onSend: () => {
                if (!composerBody.trim()) return;
                setActiveScenario((prev) => ({
                  ...prev,
                  messages: [
                    ...prev.messages,
                    {
                      id: `msg-user-${Date.now()}`,
                      roomId: prev.room.id,
                      senderId: 'user',
                      senderName: '你',
                      body: composerBody,
                      kind: 'user',
                      recipientIds,
                      createdAt: new Date().toISOString(),
                    },
                  ],
                }));
                setComposerBody('');
              },
              onRetryDraft: () => {},
            }}
          />
        </section>

        {/* 右侧上下文面板 */}
        <InspectorPanel
          room={activeScenario.room}
          roomTasks={activeScenario.tasks}
          roomArtifacts={activeScenario.artifacts || []}
          roomRuns={activeScenario.runs}
          members={activeScenario.members}
          focusTask={focusTask}
          contextOpen={contextOpen}
          inspectorOpen={inspectorDockOpen}
          archiveBusy={false}
          busyTaskIds={[]}
          tasks={activeScenario.tasks}
          onClose={() => setContextOpen(false)}
          onArchiveRoom={() => {}}
          onCreateTask={() => {}}
          onOpenTask={(id, sec) => {
            setSelectedTaskId(id);
            if (sec) setSelectedSection(sec);
            setInspectorDockOpen(true);
          }}
          onOpenRun={(id) => {
            const r = activeScenario.runs.find((run) => run.id === id);
            if (r) setSelectedRun(r);
          }}
          onCancelRun={() => {}}
          onArtifact={(artifact) => setPreviewArtifact(artifact)}
          progress={null}
        />

        {/* 交互检查详情抽屉 */}
        {inspectorDockOpen && focusTask && (
          <div
            className="workbench-detail-dock context-open"
            style={{
              padding: '16px',
              overflowY: 'auto',
              borderLeft: '1px solid var(--wb-border)',
              background: 'white',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--wb-border)',
                paddingBottom: '10px',
                marginBottom: '14px',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '15px' }}>
                任务详情检查: {focusTask.title}
              </h3>
              <button
                className="btn btn-sm btn-icon-only"
                onClick={() => setInspectorDockOpen(false)}
                title="关闭检查区"
              >
                <X size={15} />
              </button>
            </div>

            {/* 目标与基本状态 */}
            <div style={{ marginBottom: '16px', fontSize: '12px' }}>
              <div>
                <strong>目标:</strong> {focusTask.objective}
              </div>
              <div style={{ marginTop: '4px' }}>
                <strong>状态:</strong> {focusTask.status} · <strong>当前摘要:</strong>{' '}
                {focusTask.summary || '无'}
              </div>
            </div>

            {/* 场景 3：材料上传与重试表单 */}
            {scenarioId === 'material_partial_failure' && (
              <div
                className="structured-card kind-help"
                style={{ marginBottom: '16px' }}
              >
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                  <AlertTriangle size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  材料导入状态 (部分失败)
                </div>
                <div style={{ fontSize: '12px', marginBottom: '8px' }}>
                  schema.json 已通过哈希核验；data-large.csv (503 服务不可用) 导入失败。
                </div>
                <button className="btn btn-sm btn-primary" onClick={handleRetryMaterial}>
                  <RotateCcw size={13} /> 重试失败材料
                </button>
              </div>
            )}

            {/* 场景 4：业务求助人工答复表单 */}
            {activeScenario.progress?.assistance &&
              activeScenario.progress.assistance.length > 0 && (
                <div
                  className="structured-card kind-help"
                  style={{ marginBottom: '16px' }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                    <HelpCircle size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                    等待人工答复业务求助
                  </div>
                  <div style={{ fontSize: '12px', marginBottom: '8px' }}>
                    <strong>求助问题:</strong>{' '}
                    {activeScenario.progress.assistance[0].question}
                  </div>
                  {activeScenario.progress.assistance[0].status === 'blocked' ? (
                    <div>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="输入您的业务确认答复..."
                        value={answerInput}
                        onChange={(e) => setAnswerInput(e.target.value)}
                        style={{
                          width: '100%',
                          fontSize: '12px',
                          padding: '6px 8px',
                          marginBottom: '8px',
                        }}
                      />
                      <button className="btn btn-sm btn-primary" onClick={handleSubmitAnswer}>
                        <Send size={12} /> 提交答复并解除阻断
                      </button>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--wb-success)', fontSize: '12px' }}>
                      ✓ 求助已答复: {activeScenario.progress.assistance[0].answer}
                    </div>
                  )}
                </div>
              )}

            {/* 场景 6：门禁验收与重新验证表单 */}
            {scenarioId === 'acceptance_failure_stale' && (
              <div
                className="structured-card kind-verification"
                style={{ marginBottom: '16px' }}
              >
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                  门禁验证状态: {focusTask.gate.status}
                </div>
                <div style={{ fontSize: '12px', marginBottom: '8px' }}>
                  {focusTask.gate.summary}
                </div>
                {focusTask.gate.status !== 'passed' && (
                  <button className="btn btn-sm btn-secondary" onClick={handleRerunGate}>
                    <Play size={12} /> 重新执行自动验证
                  </button>
                )}
              </div>
            )}

            {/* 场景 7：局部恢复断点展示 */}
            {activeScenario.progress?.resume && (
              <div
                className="structured-card kind-artifact"
                style={{ marginBottom: '16px' }}
              >
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>
                  <CheckCircle size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  断点步骤复用分析
                </div>
                <div style={{ fontSize: '12px' }}>
                  复用比例: {activeScenario.progress.resume.reusableSteps} /{' '}
                  {activeScenario.progress.resume.totalSteps} 步骤 ·{' '}
                  {activeScenario.progress.resume.reason}
                </div>
              </div>
            )}

            {/* 关联产物清单 */}
            <div>
              <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px' }}>
                产物列表 ({(activeScenario.artifacts || []).length})
              </div>
              {(activeScenario.artifacts || []).length === 0 ? (
                <div style={{ fontSize: '12px', color: 'var(--wb-text-secondary)' }}>
                  当前任务尚无产物生成
                </div>
              ) : (
                (activeScenario.artifacts || []).map((art) => (
                  <div
                    key={art.id}
                    className="artifact-item"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px',
                      border: '1px solid var(--wb-border)',
                      borderRadius: '4px',
                      marginBottom: '6px',
                    }}
                  >
                    <span style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <FileText size={14} /> {art.name}
                    </span>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => setPreviewArtifact(art)}
                    >
                      <Eye size={12} /> 预览
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* 产物预览浮层 */}
        {previewArtifact && (
          <div className="modal-overlay" onClick={() => setPreviewArtifact(null)}>
            <div
              className="modal-card"
              style={{ width: '600px', maxWidth: '90%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3>产物预览: {previewArtifact.name}</h3>
                <button
                  className="btn btn-sm btn-icon-only"
                  onClick={() => setPreviewArtifact(null)}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="modal-body" style={{ maxHeight: '380px', overflowY: 'auto' }}>
                <pre
                  style={{
                    background: '#f6f8fa',
                    padding: '12px',
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                >
                  {JSON.stringify(
                    {
                      file: previewArtifact.relativePath,
                      size: previewArtifact.size,
                      sha256: previewArtifact.sha256,
                      updatedAt: previewArtifact.updatedAt,
                      mockContent: '=== [演示环境产物数据与格式核验正常] ===',
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* 运行作业日志浮层 */}
        {selectedRun && (
          <div className="modal-overlay" onClick={() => setSelectedRun(null)}>
            <div
              className="modal-card"
              style={{ width: '650px', maxWidth: '90%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h3>运行日志: {selectedRun.id}</h3>
                <button
                  className="btn btn-sm btn-icon-only"
                  onClick={() => setSelectedRun(null)}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="modal-body" style={{ maxHeight: '380px', overflowY: 'auto' }}>
                <div style={{ marginBottom: '8px', fontSize: '12px' }}>
                  阶段: {selectedRun.stage} · 状态: {selectedRun.status} · 退出码:{' '}
                  {selectedRun.exitCode ?? '无'}
                </div>
                <pre
                  style={{
                    background: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: '12px',
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                >
                  {`[${selectedRun.startedAt}] Process spawned with executionMode: direct\n[${selectedRun.startedAt}] Task ID: ${selectedRun.taskId}\n${selectedRun.summary}\n${selectedRun.error ? '[ERROR] ' + selectedRun.error : '[SUCCESS] Finished with zero exit code.'}`}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
