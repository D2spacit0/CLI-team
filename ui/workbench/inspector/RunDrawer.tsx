import React from 'react';
import { Terminal, RefreshCw, X, AlertCircle, Square } from 'lucide-react';
import type { Run } from '../../types';
import RunDiagnostics from '../../RunDiagnostics';
import { runStatusLabels, stageLabels } from '../roomState';

interface RunDrawerProps {
  runData: {
    run: Run;
    result: string;
    logTail: string;
  } | null;
  selectedRunId: string | null;
  loading: boolean;
  runLogError: string;
  runReturnTask: boolean;
  isTaskBusy: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onCancelRun: (runId: string) => void;
}

export function RunDrawer({
  runData,
  selectedRunId,
  loading,
  runLogError,
  runReturnTask,
  isTaskBusy,
  onRefresh,
  onClose,
  onCancelRun,
}: RunDrawerProps) {
  if (!runData) {
    return (
      <div className="modal-overlay">
        <div className="modal-content" role="dialog" aria-label="正在加载作业日志">
          <div className="modal-header">
            <span className="modal-title">作业日志</span>
            <button className="btn btn-sm btn-secondary" onClick={onClose}>
              {runReturnTask ? '返回任务' : '关闭日志'}
            </button>
          </div>
          <div className="modal-body" role="status">
            正在加载作业日志…
          </div>
        </div>
      </div>
    );
  }

  const { run, result, logTail } = runData;
  const stageName = stageLabels[run.stage] || run.stage;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={16} />
            <span className="modal-title">作业执行日志 · {stageName}</span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {runReturnTask && (
              <button className="btn btn-sm btn-secondary" onClick={onClose}>
                返回任务
              </button>
            )}
            <button
              className="btn btn-sm btn-secondary"
              onClick={onRefresh}
              title="刷新日志"
            >
              <RefreshCw size={12} />
              <span>刷新</span>
            </button>
            <button
              className="btn btn-sm btn-secondary btn-icon-only"
              aria-label="关闭作业日志"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: '16px', fontSize: '12px' }}>
            <div>
              <strong>状态: </strong>
              <span>{runStatusLabels[run.status] || run.status}</span>
            </div>
            <div>
              <strong>退出代码: </strong>
              <span>
                {run.exitCode ??
                  (['running', 'queued'].includes(run.status) ? '运行中' : '未提供')}
              </span>
            </div>
            <div>
              <strong>跳数/轮次: </strong>
              <span>{run.hop}</span>
            </div>
            <div>
              <strong>创建时间: </strong>
              <span>{new Date(run.createdAt).toLocaleTimeString()}</span>
            </div>
          </div>

          {runLogError && (
            <div className="error-banner" role="alert">
              {runLogError}（保留上次日志，可点击刷新重试）
            </div>
          )}
          {['running', 'queued'].includes(run.status) && (
            <p className="text-muted">日志每 2 秒自动刷新。</p>
          )}
          {run.warnings?.map((warning, index) => (
            <div className="run-warning" key={index}>
              <AlertCircle size={15} />
              <span>{warning}</span>
            </div>
          ))}
          {(run.runtime || run.riskFlags.length > 0 ||
            ['failed', 'blocked', 'cancelled', 'interrupted'].includes(run.status)) && (
            <RunDiagnostics run={run} />
          )}
          {run.error && (
            <div className="error-banner">
              <AlertCircle size={14} />
              <span>{run.error}</span>
            </div>
          )}

          <div>
            <div className="form-label">终端实时输出 (Log Tail)</div>
            <div className="log-terminal">{logTail || '(暂无终端输出内容)'}</div>
          </div>

          {result && (
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
                {result}
              </pre>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {['running', 'queued'].includes(run.status) && (
            <button
              className="btn btn-danger"
              disabled={isTaskBusy}
              onClick={() => onCancelRun(run.id)}
            >
              <Square size={13} />
              <span>终止执行</span>
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
