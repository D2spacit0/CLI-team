import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, FileText, LockKeyhole, Send, Users, X } from 'lucide-react';
import type { Member, Room, Task } from '../../types';
import { memberUnavailableReason } from '../../memberAvailability';
import { messageAudience } from '../roomState';

export interface RoomComposerState {
  body: string;
  recipientIds: string[];
  taskId: string;
  analysisOnly: boolean;
  sending: boolean;
  loaded: boolean;
  pendingReceipt?: boolean;
  saving: boolean;
  draftError: string;
  error: string;
  onBody: (body: string) => void;
  onRecipients: (ids: string[]) => void;
  onTask: (id: string) => void;
  onClearTask: () => void;
  onAnalysis: (value: boolean) => void;
  onSend: () => void;
  onRetryDraft: () => void;
}

interface RoomComposerProps {
  room: Room | undefined;
  roomTasks: Task[];
  members: Member[];
  composer: RoomComposerState;
}

export function RoomComposer({ room, roomTasks, members, composer }: RoomComposerProps) {
  const composing = useRef(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  useEffect(() => setRecipientsOpen(false), [room?.id]);

  const audience = messageAudience(composer.body, composer.recipientIds, members);
  const associatedTask = room?.taskId || composer.taskId;
  const missingTask = associatedTask && !roomTasks.some((task) => task.id === associatedTask);
  const associatedTaskTitle = roomTasks.find((task) => task.id === associatedTask)?.title;
  const missingTaskIssue = missingTask && !room?.taskId
    ? '关联任务已归档或不属于此聊天室，请解除关联后发送。'
    : missingTask
    ? '房间关联任务已归档，暂时不能向成员派工。'
    : '';

  const deliveryIssue =
    audience.problems[0] ||
    missingTaskIssue ||
    (composer.body.trim().length > 12000 ? '消息最多 12000 字，请缩短后发送。' : '');
  const deliveryMode = deliveryIssue
    ? { tone: 'blocked', icon: <X size={13} />, title: '暂时不能发送', detail: deliveryIssue }
    : audience.ids.length
    ? {
        tone: 'members',
        icon: <Users size={13} />,
        title: `将派给 ${audience.recipients.map((member, index) => member?.name || audience.ids[index]).join('、')}`,
        detail: associatedTask
          ? '这是一条关联任务的只读咨询，不会改变任务状态。'
          : audience.commander
          ? '同时通知主控；发送后会生成成员作业。'
          : '发送后会生成成员作业，并在聊天室保留记录。',
      }
    : {
        tone: 'room',
        icon: <LockKeyhole size={13} />,
        title: '只保存到聊天室，不会派给成员',
        detail: '选择收件人或使用 @成员 提及，才会生成成员作业。',
      };

  const disabled = composer.sending || !composer.loaded || !room || Boolean(room.archivedAt);
  const selectableMembers = members.filter(
    (member) => member.provider !== 'controller' && member.role !== 'controller'
  );
  const availableMembers = selectableMembers.filter((member) => !memberUnavailableReason(member));
  const unavailableMembers = selectableMembers.filter((member) =>
    Boolean(memberUnavailableReason(member)) && !composer.recipientIds.includes(member.id)
  );
  const selectedMembers = composer.recipientIds
    .map((id) => selectableMembers.find((member) => member.id === id))
    .filter((member): member is Member => Boolean(member));
  const allRecipients = [
    ...selectedMembers,
    ...availableMembers.filter((member) => !composer.recipientIds.includes(member.id)),
  ];
  const compactRecipients = recipientsOpen
    ? allRecipients
    : allRecipients.slice(0, Math.max(4, selectedMembers.length));
  const hiddenAvailableCount = Math.max(0, allRecipients.length - compactRecipients.length);
  const hiddenUnavailableCount = unavailableMembers.length;
  const hiddenRecipientCount = hiddenAvailableCount + hiddenUnavailableCount;
  const recipientToggleLabel = recipientsOpen
    ? '收起成员'
    : hiddenAvailableCount > 0
    ? `更多 ${hiddenRecipientCount} 名成员`
    : `${hiddenUnavailableCount} 名不可用`;

  return (
    <div className="chat-compose-area">
      {/* 收件人选择栏 */}
      <div
        className={`compose-recipients-bar${recipientsOpen ? ' expanded' : ''}`}
        aria-label="收件人选择"
      >
        <span className="compose-label">
          收件人
          {audience.ids.length > 0 && <strong>{audience.ids.length}</strong>}
        </span>
        {compactRecipients.map((member) => {
          const selected = composer.recipientIds.includes(member.id);
          const mentioned = audience.ids.includes(member.id) && !selected;
          const reason = memberUnavailableReason(member);
          const cannotSelect = Boolean(!selected && (reason || audience.ids.length >= 4));

          return (
            <button
              className={`member-chip${selected ? ' selected' : mentioned ? ' mentioned' : ''}`}
              key={member.id}
              type="button"
              aria-pressed={selected}
              title={
                reason ||
                `${member.name} · @${member.handle}${member.status === 'busy'
                  ? ' · 正忙，发送后排队'
                  : audience.ids.length >= 4 && !selected
                  ? ' · 单条消息最多选择 4 名成员'
                  : ''}`
              }
              aria-label={reason ? `${member.name}不可选择：${reason}` : undefined}
              data-unavailable-reason={reason || undefined}
              disabled={disabled || cannotSelect}
              onClick={() =>
                composer.onRecipients(
                  selected
                    ? composer.recipientIds.filter((id) => id !== member.id)
                    : [...composer.recipientIds, member.id]
                )
              }
            >
              <span>{member.name}</span>
              {reason && <small className="member-unavailable-label">{reason}</small>}
              {mentioned && <small>@</small>}
              {member.status === 'busy' && <span className="member-busy-dot" />}
            </button>
          );
        })}
        {composer.recipientIds
          .filter((id) => !members.some((member) => member.id === id))
          .map((id) => (
            <button
              className="member-chip selected"
              key={id}
              disabled={disabled}
              onClick={() => composer.onRecipients(composer.recipientIds.filter((item) => item !== id))}
            >
              移除失效成员 {id}
              <X size={11} />
            </button>
          ))}
        {hiddenRecipientCount > 0 && (
          <button
            type="button"
            className="recipient-more-toggle"
            aria-expanded={recipientsOpen}
            aria-controls="compose-more-recipients"
            onClick={() => setRecipientsOpen((value) => !value)}
          >
            {recipientToggleLabel}
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
        {recipientsOpen && hiddenUnavailableCount > 0 && (
          <div className="compose-unavailable-members" id="compose-more-recipients">
            <span className="compose-unavailable-caption">这些成员不能接收新消息</span>
            {unavailableMembers.map((member) => {
              const reason = memberUnavailableReason(member) || '当前不可用';
              return (
                <button
                  className="member-chip"
                  key={member.id}
                  type="button"
                  title={`${member.name} · @${member.handle} · ${reason}`}
                  aria-label={`${member.name}不可选择：${reason}`}
                  data-unavailable-reason={reason}
                  disabled
                >
                  <span>{member.name}</span>
                  <small className="member-unavailable-label">{reason}</small>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 文本输入框 */}
      <div className="compose-box">
        <textarea
          className="compose-textarea"
          aria-label="消息"
          placeholder="输入消息，或使用 @成员指定接收人"
          value={composer.body}
          maxLength={24000}
          disabled={disabled}
          onChange={(event) => composer.onBody(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.ctrlKey || event.metaKey) &&
              !composing.current &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault();
              if (!disabled && (composer.pendingReceipt || (!deliveryIssue && composer.body.trim()))) {
                composer.onSend();
              }
            }
          }}
        />
      </div>

      {/* 发送目标与预览 */}
      <div className="compose-meta-row">
        <div className="compose-delivery" data-tone={deliveryMode.tone} aria-live="polite">
          <span className="compose-delivery-title">
            {deliveryMode.icon}
            <strong>{deliveryMode.title}</strong>
          </span>
          <span className="compose-delivery-detail">{deliveryMode.detail}</span>
          {audience.unknown.length > 0 && (
            <span className="text-muted">
              未匹配的提及不会派工：{audience.unknown.map((handle) => `@${handle}`).join('、')}
            </span>
          )}
        </div>
        <div className="compose-options">
          <label className="compose-task-select">
            <FileText size={13} />
            <select
              aria-label="消息关联任务"
              value={associatedTask || ''}
              disabled={disabled || Boolean(room?.taskId)}
              onChange={(event) => composer.onTask(event.target.value)}
            >
              <option value="">房间讨论</option>
              {roomTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
              {missingTask && <option value={associatedTask}>关联任务已不可用</option>}
            </select>
            {missingTask && !room?.taskId && (
              <button type="button" className="file-link compose-clear-task" onClick={composer.onClearTask}>
                解除关联
              </button>
            )}
          </label>
          <label className="compose-analysis-mode">
            <input
              type="checkbox"
              checked={composer.analysisOnly}
              disabled={disabled}
              onChange={(event) => composer.onAnalysis(event.target.checked)}
            />
            <span>仅依据现有信息分析</span>
          </label>
        </div>
      </div>
      {associatedTask && associatedTaskTitle && (
        <div className="compose-associated-task" role="status">
          <FileText size={12} aria-hidden="true" />
          <span>消息会关联到「{associatedTaskTitle}」</span>
          {!room?.taskId && (
            <button type="button" className="file-link" onClick={composer.onClearTask}>
              改为房间讨论
            </button>
          )}
        </div>
      )}

      {/* 错误与草稿状态提示 */}
      {(deliveryIssue || composer.error) && (
        <div className="compose-error" role="alert">
          {deliveryIssue || composer.error}
        </div>
      )}
      {composer.draftError && (
        <div className="compose-error" role="alert">
          <span>{composer.draftError}</span>
          <button className="file-link" onClick={composer.onRetryDraft}>
            重试保存
          </button>
        </div>
      )}

      {/* 底部操作与快捷键提示 */}
      <div className="compose-footer-hint">
        <span role="status" className="compose-draft-status">
          {composer.loaded && !composer.saving && !composer.draftError && <CheckCircle2 size={12} aria-hidden="true" />}
          <span>
            {!composer.loaded
              ? '正在恢复草稿…'
              : composer.saving
              ? '正在保存草稿…'
              : composer.draftError
              ? '草稿尚未保存'
              : '草稿已保存'}
            <span className="compose-shortcut"> · Ctrl / ⌘ + Enter 发送</span>
          </span>
        </span>
        <button
          className="btn btn-primary compose-send"
          onClick={composer.onSend}
          disabled={disabled || (!composer.pendingReceipt && (!composer.body.trim() || Boolean(deliveryIssue)))}
        >
          <Send size={14} />
          {composer.sending
            ? '正在发送…'
            : composer.pendingReceipt
            ? '核对并重试'
            : audience.ids.length
            ? `派给 ${audience.ids.length} 名成员`
            : '只保存到聊天室'}
        </button>
      </div>
    </div>
  );
}
