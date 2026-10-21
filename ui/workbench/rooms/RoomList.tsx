import React, { useState } from 'react';
import { Plus, Search, MessagesSquare, CheckSquare } from 'lucide-react';
import type { Room, Task } from '../../types';

interface RoomListProps {
  rooms: Room[];
  roomId: string | null;
  tasks: Task[];
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
  onCreateTask: () => void;
}

export function RoomList({
  rooms,
  roomId,
  tasks,
  onSelectRoom,
  onCreateRoom,
  onCreateTask,
}: RoomListProps) {
  const [filter, setFilter] = useState('');

  const filteredRooms = rooms.filter((item) =>
    item.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  const currentRoom = rooms.find((r) => r.id === roomId);

  return (
    <aside className="room-subsidebar" aria-label="聊天室列表">
      <div className="subsidebar-header">
        <strong>聊天室</strong>
        <button
          className="btn btn-sm btn-secondary btn-icon-only"
          onClick={onCreateRoom}
          title="创建新讨论室"
          aria-label="创建新讨论室"
        >
          <Plus size={15} />
        </button>
      </div>

      <label className="room-search">
        <Search size={14} />
        <input
          aria-label="筛选聊天室"
          placeholder="筛选聊天室"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>

      <div className="subsidebar-content">
        {filteredRooms.map((item) => {
          const attention = tasks.filter(
            (task) =>
              task.roomId === item.id &&
              !task.archivedAt &&
              ['blocked', 'review'].includes(task.status)
          ).length;
          const runningTask = tasks.find(
            (task) =>
              task.roomId === item.id &&
              !task.archivedAt &&
              task.status === 'running'
          );

          return (
            <button
              key={item.id}
              className={`room-item ${item.id === roomId ? 'active' : ''}`}
              onClick={() => onSelectRoom(item.id)}
              aria-current={item.id === roomId ? 'page' : undefined}
            >
              <span className="room-symbol" aria-hidden="true">
                {item.kind === 'task' ? <CheckSquare size={16} /> : <MessagesSquare size={16} />}
              </span>
              <span className="room-item-copy">
                <span className="room-name">{item.name}</span>
                <small>
                  {attention
                    ? `${attention} 项需要处理`
                    : runningTask
                    ? '任务执行中'
                    : item.kind === 'task'
                    ? '任务聊天室'
                    : '持续讨论'}
                </small>
              </span>
              {attention > 0 && (
                <span className="room-attention-dot" aria-label={`${attention} 项需要处理`} />
              )}
            </button>
          );
        })}

        {!rooms.length && <p className="empty-state">还没有聊天室</p>}
        {rooms.length > 0 && !filteredRooms.length && (
          <p className="empty-state">没有匹配的聊天室</p>
        )}
      </div>

      <button
        className="btn btn-secondary room-create-task"
        disabled={!currentRoom}
        onClick={onCreateTask}
      >
        <Plus size={14} />
        新建协作任务
      </button>
    </aside>
  );
}
