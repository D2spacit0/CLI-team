import type {
  Bootstrap,
  Room,
  Message,
  MessagePage,
  Member,
  Task,
  TaskProgress,
  Run,
  RunDetails,
  Meeting,
  Settings,
  ExternalSession,
  Material,
  MaterialList,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    let errorMsg = `请求失败 (${res.status} ${res.statusText})`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') {
        errorMsg = data.error;
      }
    } catch {
      // 忽略无法解析的 JSON
    }
    throw new ApiError(errorMsg, res.status);
  }

  // 针对无内容的响应
  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

export const api = {
  submitObjective: (data: { requestId: string; objective: string; roomId: string }) =>
    request<Task>('/api/requests', { method: 'POST', body: JSON.stringify(data), signal: AbortSignal.timeout(15000) }),
  // Bootstrap
  getBootstrap: (includeArchived = false) => request<Bootstrap>(`/api/bootstrap${includeArchived ? '?archived=1' : ''}`),
  setArchived: (kind: 'tasks' | 'rooms', id: string, archived: boolean) =>
    request<Task | Room>(`/api/${kind}/${encodeURIComponent(id)}/${archived ? 'archive' : 'restore'}`, {
      method: 'POST', body: '{}',
    }),
  getArtifactPreview: (id: string) =>
    request<{ artifactId: string; name: string; text: string; sha256: string }>(`/api/artifacts/${encodeURIComponent(id)}/preview`),
  getArtifactDownload: async (id: string) => {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(id)}`);
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new ApiError(typeof detail?.error === 'string' ? detail.error : `下载失败（${response.status}），请重试`, response.status);
    }
    return response.blob();
  },
  getDshSessions: () => request<{
    home: string; sessions: ExternalSession[]; warnings: { session: string; error: string }[];
  }>('/api/integrations/dsh/sessions'),
  importDshSession: (sessionId: string) => request<ExternalSession>('/api/integrations/dsh/import', {
    method: 'POST', body: JSON.stringify({ sessionId }),
  }),
  refreshDshSessions: () => request<{
    sessions: ExternalSession[]; errors: { id: string; error: string }[];
  }>('/api/integrations/dsh/refresh', { method: 'POST', body: '{}' }),

  // Rooms & Messages
  getRoomMessages: (roomId: string) =>
    request<Message[]>(`/api/rooms/${encodeURIComponent(roomId)}/messages`),

  getRoomMessagePage: (roomId: string, options: { before?: string; after?: string } = {}) => {
    const query = new URLSearchParams(options);
    return request<MessagePage>(`/api/rooms/${encodeURIComponent(roomId)}/messages/page${query.size ? `?${query}` : ''}`, {
      signal: AbortSignal.timeout(15000),
    });
  },

  createRoom: (name: string, requestId?: string) =>
    request<Room>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, requestId }),
    }),

  getMessageReceipt: (roomId: string, requestId: string) =>
    request<{ message: Message | null; fingerprint?: string }>(`/api/rooms/${encodeURIComponent(roomId)}/message-requests/${encodeURIComponent(requestId)}`),

  sendMessage: (roomId: string, body: string, recipientIds: string[] = [], analysisOnly = false, taskId?: string, requestId?: string) =>
    request<Message>(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, recipientIds, analysisOnly, taskId, requestId }),
    }),

  // Meetings
  createMeeting: (roomId: string, objective: string, memberIds: string[], requestId?: string) =>
    request<Meeting>('/api/meetings', {
      method: 'POST',
      body: JSON.stringify({ roomId, objective, memberIds, requestId }),
    }),

  // Members
  resetRunConversation: (run: Run) => request<{ reset: boolean }>(`/api/rooms/${encodeURIComponent(run.roomId)}/members/${encodeURIComponent(run.memberId)}/reset`, {
    method: 'POST', body: JSON.stringify({ confirm: true, runId: run.id, taskId: run.taskId || run.contextTaskId || undefined }),
  }),
  probeMember: (id: string) => request<Member>(`/api/members/${encodeURIComponent(id)}/probe`, {
    method: 'POST', body: '{}',
  }),
  discoverMembers: () =>
    request<{ members: Member[] }>('/api/members/discover', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  createMember: (data: {
    skills?: string;
    name: string;
    handle: string;
    provider: Member['provider'];
    role: Member['role'];
    model: string;
    executable: string;
    prefixArgs: string[];
    customArgs: string[];
    inputMode: 'argument' | 'stdin';
    enabled: boolean;
    permission: 'plan' | 'edit';
    dshConfigProfile?: Member['dshConfigProfile'];
  }) =>
    request<Member>('/api/members', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateMember: (
    id: string,
    data: Partial<{
      skills: string;
      name: string;
      handle: string;
      provider: Member['provider'];
      role: Member['role'];
      model: string;
      executable: string;
      prefixArgs: string[];
      customArgs: string[];
      inputMode: 'argument' | 'stdin';
      enabled: boolean;
      permission: 'plan' | 'edit';
      dshConfigProfile?: Member['dshConfigProfile'];
    }>
  ) =>
    request<Member>(`/api/members/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Tasks
  taskProgress: (id: string) => request<TaskProgress>(`/api/tasks/${encodeURIComponent(id)}/progress`),
  pauseTask: (id: string) => request<Task>(`/api/tasks/${encodeURIComponent(id)}/pause`, {
    method: 'POST', body: JSON.stringify({}),
  }),
  answerTaskAssistance: (taskId: string, helpId: string, answer: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/assistance/${encodeURIComponent(helpId)}/answer`, {
      method: 'POST', body: JSON.stringify({ answer }),
    }),
  getMaterials: (taskId: string) =>
    request<MaterialList>(`/api/tasks/${encodeURIComponent(taskId)}/materials`),
  importMaterial: (taskId: string, name: string, contentBase64: string, sha256: string) =>
    request<Material>(`/api/tasks/${encodeURIComponent(taskId)}/materials`, {
      method: 'POST', body: JSON.stringify({ name, contentBase64, sha256 }),
    }),
  removeMaterial: (taskId: string, materialId: string) =>
    request<MaterialList>(`/api/tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(materialId)}`, {
      method: 'DELETE',
    }),
  createTask: (data: {
    executionMode?: 'direct' | 'delegated';
    participantIds?: string[];
    title: string;
    objective: string;
    assigneeId: string;
    reviewerId: string | null;
    requirements: string[];
    verification: null | { executable: string; args: string[] };
    start: boolean;
    sourceSessionId?: string;
    roomId?: string;
    category?: 'work' | 'test';
    creationRequestId?: string;
  }) =>
    request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  startTask: (id: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  startPreparedTask: (id: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/start`, {
      method: 'POST', body: JSON.stringify({ expectedState: 'unstarted' }),
    }),
  reassignTask: (id: string, assigneeId: string, reviewerId: string | null, note: string, participantIds?: string[]) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/reassign`, {
      method: 'POST', body: JSON.stringify({ assigneeId, reviewerId, note, participantIds }),
    }),

  cancelTask: (id: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  reviseTask: (id: string, feedback: string) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/revise`, {
      method: 'POST',
      body: JSON.stringify({ feedback }),
    }),

  acceptTask: (id: string, note: string, acknowledgeMissingGate: boolean) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ note, acknowledgeMissingGate }),
    }),

  // Runs
  getRunDetails: (id: string) =>
    request<RunDetails>(
      `/api/runs/${encodeURIComponent(id)}`
    ),

  cancelRun: (id: string) =>
    request<Run>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Settings
  updateSettings: (data: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

export interface SSEEvent {
  type: string;
  revision: number | string;
  payload: unknown;
}

export function subscribeEvents(
  onEvent: (event: SSEEvent) => void,
  onStatusChange: (status: 'connected' | 'connecting' | 'disconnected') => void
): () => void {
  let eventSource: EventSource | null = null;
  let isClosed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (isClosed) return;
    onStatusChange('connecting');
    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      onStatusChange('connected');
    };

    eventSource.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as SSEEvent;
        onEvent(parsed);
      } catch {
        // 忽略非 JSON 消息
      }
    };

    eventSource.onerror = () => {
      onStatusChange('disconnected');
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!isClosed) {
        retryTimer = setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return () => {
    isClosed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
