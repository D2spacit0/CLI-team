import React, { useEffect, useState } from 'react';
import type { RefCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Artifact, Member, Message, Room, Run, Task, TaskProgress } from '../types';
import ChatTimeline, { type HistoryControls } from './ChatTimeline';
import { RoomList } from './rooms/RoomList';
import { RoomHeader } from './rooms/RoomHeader';
import { RoomComposer, type RoomComposerState } from './rooms/RoomComposer';
import { TaskRelay } from './inspector/TaskRelay';
import { InspectorPanel } from './inspector/InspectorPanel';
import { taskStateView } from './taskState';

export type { RoomComposerState as RoomComposer };

interface Props {
  workspace: string;
  rooms: Room[];
  roomId: string | null;
  tasks: Task[];
  members: Member[];
  messages: Message[];
  loading: boolean;
  error: string | null;
  history: HistoryControls;
  artifacts: Artifact[];
  runs: Run[];
  selectedTaskId: string | null;
  progress: TaskProgress | null;
  composer: RoomComposerState;
  inspectorOpen: boolean;
  dockRef: RefCallback<HTMLDivElement>;
  archiveBusy: boolean;
  busyTaskIds: string[];
  onRoom: (id: string) => void;
  onRefresh: () => void;
  onCreateRoom: () => void;
  onCreateTask: () => void;
  onMeeting: () => void;
  onOpenTask: (id: string, section?: string) => void;
  onOpenRun: (id: string) => void;
  onArtifact: (artifact: Artifact) => void;
  onCancelRun: (id: string) => void;
  onArchiveRoom: (id: string) => void;
  hidden?: boolean;
}

export default function RoomWorkbench(props: Props) {
  const {
    workspace,
    rooms,
    roomId,
    tasks,
    members,
    messages,
    loading,
    error,
    artifacts,
    runs,
    composer,
    onOpenTask,
    onOpenRun,
  } = props;

  const [contextOpen, setContextOpen] = useState(false);
  const [taskScopeExpanded, setTaskScopeExpanded] = useState(false);
  useEffect(() => {
    setContextOpen(false);
    setTaskScopeExpanded(false);
  }, [roomId]);

  const room = rooms.find((item) => item.id === roomId);
  const roomTasks = tasks.filter((task) => task.roomId === roomId && !task.archivedAt);
  const roomRuns = runs.filter((run) => run.roomId === roomId);
  const roomArtifacts = artifacts.filter((artifact) => roomTasks.some((task) => task.id === artifact.taskId));

  const focusTask =
    roomTasks.find((task) => task.id === props.selectedTaskId) ||
    roomTasks.find((task) => task.id === room?.taskId) ||
    roomTasks.find((task) => ['running', 'blocked', 'review'].includes(task.status)) ||
    roomTasks[0];
  const focusState = focusTask ? taskStateView(focusTask, members, props.progress) : null;

  const selectRoom = (id: string) => {
    setContextOpen(false);
    props.onRoom(id);
  };

  const chooseTask = (id: string, section?: string) => {
    setContextOpen(false);
    onOpenTask(id, section);
  };

  return (
    <div
      className={`discussion-view room-workbench${props.inspectorOpen ? ' inspector-open' : ''}`}
      data-testid="room-workbench"
      hidden={props.hidden}
      style={props.hidden ? { display: 'none' } : undefined}
    >
      <RoomList
        rooms={rooms}
        roomId={roomId}
        tasks={tasks}
        onSelectRoom={selectRoom}
        onCreateRoom={props.onCreateRoom}
        onCreateTask={props.onCreateTask}
      />

      <section className="chat-main-area" aria-label="聊天室工作台">
        <RoomHeader
          room={room}
          rooms={rooms}
          roomId={roomId}
          roomTasks={roomTasks}
          loading={loading}
          contextOpen={contextOpen}
          onRoomChange={selectRoom}
          onRefresh={props.onRefresh}
          onMeeting={props.onMeeting}
          onToggleContext={() => setContextOpen((v) => !v)}
          onCreateRoom={props.onCreateRoom}
        />

        {focusTask && focusState && (
          <div
            className={`room-task-scope${taskScopeExpanded ? ' expanded' : ''}`}
            data-task-state={focusState.tone}
            data-testid="room-task-scope"
          >
            <div className="room-task-focus">
              <button
                className="room-task-row"
                aria-expanded={taskScopeExpanded}
                onClick={() => setTaskScopeExpanded((value) => !value)}
              >
                <span className={`task-state-dot state-${focusTask.status}`} />
                <span className="room-task-title">{focusTask.title}</span>
                <small>{focusState.eyebrow}</small>
                <ChevronDown size={14} className="room-task-expand-icon" />
              </button>
              <button
                className="room-task-inline-action"
                onClick={() => chooseTask(focusTask.id, focusState.action.section)}
              >
                {focusState.action.label}
                <ChevronRight size={13} />
              </button>
            </div>
            {taskScopeExpanded && (
              <div className="room-task-details">
                <p><strong>{focusState.title}</strong>{focusState.detail}</p>
                <TaskRelay
                  task={focusTask}
                  progress={props.progress}
                  members={members}
                  onOpen={() => chooseTask(focusTask.id, 'plan')}
                />
              </div>
            )}
          </div>
        )}

        <ChatTimeline
          key={`${workspace}:${roomId}`}
          scope={`${workspace}:${roomId}`}
          messages={messages.filter((message) => message.roomId === roomId)}
          members={members}
          tasks={tasks}
          runs={runs}
          loading={loading}
          error={error}
          history={props.history}
          onRefresh={props.onRefresh}
          onOpenTask={chooseTask}
          onOpenRun={onOpenRun}
          focusTask={focusTask}
        />

        <RoomComposer
          room={room}
          roomTasks={roomTasks}
          members={members}
          composer={composer}
        />
      </section>

      <InspectorPanel
        room={room}
        roomTasks={roomTasks}
        roomArtifacts={roomArtifacts}
        roomRuns={roomRuns}
        members={members}
        focusTask={focusTask}
        contextOpen={contextOpen}
        inspectorOpen={props.inspectorOpen}
        archiveBusy={props.archiveBusy}
        busyTaskIds={props.busyTaskIds}
        tasks={tasks}
        onClose={() => setContextOpen(false)}
        onArchiveRoom={props.onArchiveRoom}
        onCreateTask={props.onCreateTask}
        onOpenTask={chooseTask}
        onOpenRun={onOpenRun}
        onCancelRun={props.onCancelRun}
        onArtifact={props.onArtifact}
        progress={props.progress}
      />

      <div className="workbench-detail-dock" hidden={!props.inspectorOpen} ref={props.dockRef} />
    </div>
  );
}
