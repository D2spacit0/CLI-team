import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, History, MessagesSquare } from 'lucide-react';
import type { Member, Message, Run, Task } from '../types';
import { MessageCard } from './messages/MessageCards';
import type { TaskStateView } from './taskState';

type Anchor = { id: string; offset: number };
type Position = { top: number; following: boolean; unread: number; lastId?: string; lastSequence?: number; anchor?: Anchor };
const positions = new Map<string, Position>();
const sequenceOf = (message: Message) => 'sequence' in message && typeof message.sequence === 'number' ? message.sequence : undefined;

export interface HistoryControls {
  hasOlder: boolean; loadingOlder: boolean; olderError: string | null; loadOlder: () => void;
}

interface Props {
  scope: string; messages: Message[]; members: Member[]; tasks: Task[]; runs: Run[];
  loading: boolean; error: string | null; onRefresh: () => void;
  history?: HistoryControls;
  onOpenTask: (id: string, section?: string) => void; onOpenRun: (id: string) => void;
  focusTask?: Task;
  focusState?: TaskStateView | null;
}

export default function ChatTimeline({ scope, messages, members, tasks, runs, loading, error, history, onRefresh, onOpenTask, onOpenRun,
  focusTask, focusState }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(positions.get(scope)?.following ?? true);
  const initialized = useRef(false);
  const previousMessages = useRef<Message[]>([]);
  const anchor = useRef<Anchor | undefined>(positions.get(scope)?.anchor);
  const prependAnchor = useRef<Anchor | undefined>(undefined);
  const unreadCount = useRef(positions.get(scope)?.unread || 0);
  const [unread, setUnread] = useState(unreadCount.current);
  const [atLatest, setAtLatest] = useState(following.current);
  const updateUnread = (count: number) => { unreadCount.current = count; setUnread(count); };
  const lastId = useRef<string | undefined>(undefined);
  const lastSequence = useRef<number | undefined>(positions.get(scope)?.lastSequence);
  const previousError = useRef(error);

  const captureAnchor = (element: HTMLDivElement) => {
    const viewport = element.getBoundingClientRect();
    const entry = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > viewport.top);
    const card = entry?.querySelector<HTMLElement>('.message-card');
    return entry && card ? { id: entry.dataset.messageId!, offset: card.getBoundingClientRect().top - viewport.top } : undefined;
  };
  const restoreAnchor = (element: HTMLDivElement, saved = anchor.current) => {
    const entry = saved && element.querySelector<HTMLElement>('[data-message-id="' + CSS.escape(saved.id) + '"] .message-card');
    if (!entry || !saved) return false;
    element.scrollTop += entry.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
    return true;
  };

  const remember = () => {
    const element = scroll.current;
    if (!element?.clientHeight || !initialized.current) return;
    anchor.current = captureAnchor(element);
    positions.delete(scope);
    positions.set(scope, { top: element.scrollTop, following: following.current, unread: unreadCount.current,
      lastId: lastId.current, lastSequence: lastSequence.current, anchor: anchor.current });
    if (positions.size > 32) positions.delete(positions.keys().next().value!);
  };
  const toLatest = () => {
    following.current = true;
    setAtLatest(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    updateUnread(0);
    remember();
  };

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element?.clientHeight || (loading && !messages.length) || (error && !messages.length)) return;
    const saved = positions.get(scope);
    const previousLastId = initialized.current ? lastId.current : saved?.lastId;
    const last = previousLastId ? messages.findIndex(message => message.id === previousLastId) : -1;
    const added = lastSequence.current !== undefined
      ? messages.filter(message => (sequenceOf(message) ?? -1) > lastSequence.current!).length
      : last >= 0 ? messages.length - last - 1 : 0;
    if (!initialized.current) {
      if (!following.current && saved) {
        if (!restoreAnchor(element)) {
          // An evicted room cache may no longer contain the saved anchor. Do
          // not apply its old pixel offset to unrelated, newer messages.
          if (saved.anchor) following.current = true;
          else element.scrollTop = saved.top;
        }
      }
      if (following.current) element.scrollTop = element.scrollHeight;
      else if (added) updateUnread(unreadCount.current + added);
      initialized.current = true;
    } else if (following.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      const previous = previousMessages.current;
      const changed = previous.length !== messages.length || previous.some((message, index) => message.id !== messages[index]?.id);
      if (changed || (previousError.current !== error && element.scrollTop > 0)) restoreAnchor(element, prependAnchor.current || anchor.current);
      if (added) updateUnread(unreadCount.current + added);
    }
    if (following.current) updateUnread(0);
    setAtLatest(following.current);
    previousMessages.current = messages;
    previousError.current = error;
    lastId.current = messages.at(-1)?.id;
    for (const message of messages) {
      const sequence = sequenceOf(message);
      if (sequence !== undefined) lastSequence.current = Math.max(lastSequence.current ?? sequence, sequence);
    }
    remember();
    if (!history?.loadingOlder) prependAnchor.current = undefined;
  }, [messages, loading, error, scope, history?.loadingOlder, history?.olderError]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const resize = new ResizeObserver(() => {
      if (!element?.clientHeight || !initialized.current) return;
      if (following.current) element.scrollTop = element.scrollHeight;
      else restoreAnchor(element);
      remember();
    });
    if (element) resize.observe(element);
    return () => {
      resize.disconnect();
      remember();
    };
  }, [scope]);

  return <div className="timeline-container">
    <div className="messages-scroll-area" ref={scroll} aria-label="聊天记录" onScroll={() => {
      const element = scroll.current;
      if (!element?.clientHeight || !initialized.current) return;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
      setAtLatest(following.current);
      if (following.current) updateUnread(0);
      remember();
      if (prependAnchor.current) prependAnchor.current = anchor.current;
    }}>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="btn btn-sm btn-secondary" onClick={onRefresh}>重试加载</button></div>}
      {history && messages.length > 0 && <div className="timeline-history">
        {history.hasOlder ? <button className="btn btn-sm btn-secondary" disabled={loading || history.loadingOlder} onClick={() => {
          following.current = false; setAtLatest(false); remember(); prependAnchor.current = anchor.current; history.loadOlder();
        }}><History size={14} />{history.loadingOlder ? '正在加载更早消息…' : history.olderError ? '重试加载更早消息' : '加载更早消息'}</button>
          : <span>已显示最早的消息</span>}
        {history.olderError && <p role="alert">{history.olderError}，已读消息仍保留。</p>}
      </div>}
      {loading && !messages.length && <div className="empty-state" role="status">正在加载聊天记录…</div>}
      {!loading && !error && !messages.length && <div className="chat-empty">
        <MessagesSquare size={30} /><strong>从这里开始协作</strong>
        <p>记录想法，或选择成员发起咨询。需要分工和验收时，创建一个任务。</p>
      </div>}
      {messages.map((message, index) => {
        const day = new Date(message.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
        const newDay = index === 0 || new Date(messages[index - 1].createdAt).toDateString() !== new Date(message.createdAt).toDateString();
        return <div className="timeline-entry" key={message.id} data-message-id={message.id}>
          {newDay && <div className="timeline-date"><span>{day}</span></div>}
          <MessageCard
            message={message}
            members={members}
            tasks={tasks}
            runs={runs}
            onOpenTask={onOpenTask}
            onOpenRun={onOpenRun}
          />
        </div>;
      })}
    </div>
    {!atLatest && <button className="new-messages-button btn btn-secondary" onClick={toLatest}><ArrowDown size={14} />{unread > 0 ? `${unread} 条新消息 · ` : ''}回到最新</button>}
  </div>;
}
