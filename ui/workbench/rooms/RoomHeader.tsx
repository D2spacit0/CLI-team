import React from 'react';
import { PanelRight, Plus, RefreshCw } from 'lucide-react';
import type { Room, Task } from '../../types';

interface RoomHeaderProps {
  room: Room | undefined;
  rooms: Room[];
  roomId: string | null;
  roomTasks: Task[];
  loading: boolean;
  contextOpen: boolean;
  onRoomChange: (id: string) => void;
  onRefresh: () => void;
  onMeeting: () => void;
  onToggleContext: () => void;
  onCreateRoom: () => void;
}

export function RoomHeader({
  room,
  rooms,
  roomId,
  roomTasks,
  loading,
  contextOpen,
  onRoomChange,
  onRefresh,
  onMeeting,
  onToggleContext,
  onCreateRoom,
}: RoomHeaderProps) {
  return (
    <header className="chat-header">
      <div className="mobile-room-picker">
        <select
          aria-label="讨论房间"
          value={roomId || ''}
          onChange={(event) => onRoomChange(event.target.value)}
        >
          {!rooms.length && <option value="">未选择聊天室</option>}
          {rooms.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-sm btn-secondary btn-icon-only"
          aria-label="新建讨论房间"
          onClick={onCreateRoom}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="chat-header-title">
        <strong>{room?.name || '选择一个聊天室'}</strong>
        <small>
          {roomTasks.length
            ? `${roomTasks.length} 个任务 · 咨询与执行记录保存在这里`
            : '讨论、分工与交付'}
        </small>
      </div>

      <div className="chat-header-actions">
        <button
          className="btn btn-sm btn-secondary btn-icon-only"
          title="刷新消息"
          aria-label="刷新消息"
          disabled={!room || loading}
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="btn btn-sm btn-secondary"
          disabled={!room}
          onClick={onMeeting}
        >
          发起讨论
        </button>
        <button
          className="btn btn-sm btn-secondary room-context-toggle"
          disabled={!room}
          aria-label="房间信息"
          aria-expanded={contextOpen}
          onClick={onToggleContext}
        >
          <PanelRight size={15} />
        </button>
      </div>
    </header>
  );
}
