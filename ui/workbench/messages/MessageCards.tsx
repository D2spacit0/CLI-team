import React, { useState } from 'react';
import { HelpCircle, CheckCircle2, ShieldCheck, Terminal, FileText, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import type { Member, Message, Run, Task } from '../../types';

interface MessageCardProps {
  message: Message;
  members: Member[];
  tasks: Task[];
  runs: Run[];
  onOpenTask: (id: string) => void;
  onOpenRun: (id: string) => void;
}

const providerDisplayNames: Record<string, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  opencode: 'OpenCode',
  dsh: 'DSH',
  custom: '自定义 CLI',
  controller: '主控',
};

export function MessageCard({ message, members, tasks, runs, onOpenTask, onOpenRun }: MessageCardProps) {
  const sender = members.find((m) => m.id === message.senderId);
  const senderName = message.senderName || sender?.name || message.senderId;
  const run = runs.find((item) => item.id === message.runId);
  const task = tasks.find((item) => item.id === message.taskId);

  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const copyText = async (text: string) => {
    setCopyState('copying');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
  };

  return (
    <article className={`message-card kind-${message.kind}`}>
      <div className={`message-avatar avatar-${message.kind}`} aria-hidden="true">
        {message.kind === 'user' ? '你' : senderName.slice(0, 1)}
      </div>

      <div className="message-content">
        <div className="message-meta-row">
          <span className="message-sender">{senderName}</span>
          {sender && (
            <span className="message-provider">
              {providerDisplayNames[sender.provider] || sender.provider}
            </span>
          )}
          <span className="message-role-badge">
            {({ user: '消息', agent: '成员回执', decision: '决议', system: '系统记录' })[message.kind]}
          </span>
          <time className="message-time" dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </time>
          <button
            className="file-link"
            style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--wb-muted)' }}
            disabled={copyState === 'copying'} onClick={() => void copyText(message.body)}
            title="复制正文"
          >
            <Copy size={11} /> {copyState === 'copied' ? '已复制' : copyState === 'copying' ? '正在复制' : '复制'}
          </button>
        </div>
        {copyState === 'failed' && <p role="alert" className="text-muted">未能写入剪贴板，请重试复制，或选中正文手动复制。</p>}

        {message.recipientIds && message.recipientIds.length > 0 && (
          <div className="message-recipients">
            发给{' '}
            {message.recipientIds.map((id) => (
              <span className="recipient-pill" key={id}>
                {members.find((member) => member.id === id)?.name || id}
              </span>
            ))}
          </div>
        )}

        <div className="message-body">
          {message.body.length > 1400 ? (
            <>
              {message.body.slice(0, 480)}
              <details className="message-full">
                <summary>展开完整回执（{message.body.length} 字）</summary>
                <div>{message.body.slice(480)}</div>
              </details>
            </>
          ) : (
            message.body
          )}
        </div>

        {/* 关联上下文操作栏 */}
        {(message.taskId || message.runId) && (
          <div className="message-context-actions">
            {message.taskId && (
              <button className="file-link" onClick={() => onOpenTask(message.taskId!)}>
                <FileText size={13} />
                {task?.title || '关联任务'}
              </button>
            )}
            {message.runId && (
              <button
                className={`file-link run-state-${run?.status || 'unknown'}`}
                onClick={() => onOpenRun(message.runId!)}
              >
                <Terminal size={13} />
                {run ? `${run.status === 'succeeded' ? '执行完成' : run.status === 'running' ? '运行中' : '查看执行记录'} · 日志` : '查看执行记录'}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
