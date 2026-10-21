export interface RuntimeDiagnostics {
  transport: string; stage: string; method?: string | null; code?: string | null;
  message?: string; detail?: string; hint?: string; protocolVersion?: number;
  requestedModel?: string | null; selectedModel?: string | null; defaultModel?: string | null;
  configurationSources?: string[]; promptSubmitted?: boolean;
  modelRecovery?: { from: string; to: string; reason: string; state: 'pending' | 'applied' };
  session?: { operation: 'new' | 'resume'; requestedId: string | null; id: string | null;
    state: 'pending' | 'created' | 'resumed' | 'failed' | 'unconfirmed' };
  capabilities?: { resume: boolean; close: boolean; modelSelection: boolean };
}
export interface MemberRuntime {
  status: 'unchecked' | 'missing' | 'failed' | 'available' | 'ready';
  transport: string; fingerprint: string; checking?: boolean; checkedAt: string | null;
  version?: string | null; error?: string | null; hint?: string;
  entry: { detected: boolean; executable: string; entryPoint: string | null; error: string | null };
  checks: Record<'entry' | 'launch' | 'protocol' | 'model' | 'authentication', 'passed' | 'failed' | 'not_checked'>;
  models?: Array<{ id: string; name: string }>; selectedModel?: string | null;
  diagnostics?: RuntimeDiagnostics;
}
export interface Member {
  id: string; handle: string; name: string;
  provider: 'antigravity' | 'dsh' | 'claude' | 'gemini' | 'codex' | 'opencode' | 'custom' | 'controller';
  role: 'builder' | 'reviewer' | 'researcher' | 'controller';
  skills?: string;
  model: string; executable: string; prefixArgs: string[];
  customArgs: string[]; inputMode: 'argument' | 'stdin';
  enabled: boolean; permission: 'plan' | 'edit';
  status: 'ready' | 'busy' | 'missing' | 'disabled' | 'controller';
  detected: boolean; createdAt: string;
  dshConfigProfile?: 'auto' | 'acp' | 'desktop' | 'web';
  runtime?: MemberRuntime | null;
}
export interface Room {
  id: string; name: string; kind: 'team' | 'task'; taskId?: string; createdAt: string;
  archivedAt?: string | null;
}
export interface Message {
  id: string; roomId: string; senderId: string; senderName: string;
  kind: 'user' | 'agent' | 'system' | 'decision'; body: string;
  recipientIds: string[]; runId?: string; taskId?: string; createdAt: string;
}

export interface HistoryMessage extends Message { sequence: number }
export interface MessagePage {
  roomId: string; messages: HistoryMessage[]; hasMore: boolean;
  nextCursor: string | null; visibilityKey: string;
}
export interface Verification {
  executable: string; args: string[];
}
export interface Gate {
  status: 'not_configured' | 'pending' | 'passed' | 'failed' | 'stale';
  exitCode?: number | null; summary?: string; evidenceId?: string;
}
export type TaskStepOutput =
  | { type: 'files'; files: Array<{ path: string; format: 'any' | 'text' | 'json' }> }
  | { type: 'analysis'; sections: string[] };
export interface TaskStepOutputCheck {
  status: 'passed' | 'failed' | 'not_configured';
  type?: TaskStepOutput['type'];
  contractHash?: string;
  checkedAt: string; summary: string;
  files?: Array<{ path: string; sha256: string; size: number; format: 'any' | 'text' | 'json' }>;
  sections?: Array<{ key: string; sha256: string }>;
  issues?: string[];
}
export interface TaskStep {
  key: string; title: string; objective: string; memberId: string;
  dependsOn: string[]; status: 'pending' | 'running' | 'waiting' | 'reviewing' | 'succeeded' | 'failed';
  runId?: string | null; helpId?: string; summary?: string; attempts?: number;
  output?: TaskStepOutput | null; outputCheck?: TaskStepOutputCheck | null;
  checkpointValid?: boolean | null; checkpointReason?: string;
  reviewRunId?: string | null;
  ownerReview?: { runId: string; sourceRunId: string; ownerId: string; verdict: 'approve' | 'changes_requested';
    summary: string; reviewedAt: string; artifactRevision: string } | null;
  previousOwnerReview?: TaskStep['ownerReview'];
}
export interface TaskAssistanceRecord {
  id: string; taskId: string; planId: string; stepKey: string;
  requesterId: string; ownerId: string; question: string;
  status: 'pending' | 'consulting' | 'answered' | 'blocked' | 'cancelled';
  interrupted?: boolean;
  blocker?: string | null; consultQuestion?: string | null; peerReply?: string | null;
  coordinatorRunId?: string; consultRunId?: string; consultantId?: string;
  answer?: string; answerRunId?: string | null;
  createdAt: string; answeredAt?: string;
}
export interface Task {
  attention?: { kind: 'acceptance' | 'assistance' | 'paused' | 'blocked'; helpId?: string } | null;
  id: string; title: string; objective: string;
  status: 'backlog' | 'running' | 'review' | 'done' | 'blocked' | 'cancelled';
  assigneeId: string; reviewerId: string | null; roomId: string;
  executionMode?: 'direct' | 'delegated'; participantIds?: string[];
  managed?: boolean; autoDeliver?: boolean;
  delivery?: { status: 'ready' | 'delivered'; ownerId: string; runId: string; summary: string;
    createdAt: string; artifactRevision: string; evidenceId: string | null; gateStatus: Gate['status'];
    independentReview: string; limitation: string;
    artifacts: Array<{ id: string; relativePath: string; sha256: string }> } | null;
  coordination?: {
    phase: 'planning' | 'working' | 'checking' | 'assisting' | 'synthesizing' | 'delivering' | 'blocked' | 'cancelled' | 'review' | 'done'; round: number;
    planId?: string;
    steps: TaskStep[];
  };
  workspace: string; requirements: string[];
  verification: Verification | null; gate: Gate; repairCount: number;
  summary: string; reviewVerdict?: string; artifactRevision?: string;
  createdAt: string; updatedAt: string;
  startedAt?: string | null;
  acceptedAt?: string | null;
  acceptanceNote?: string;
  pausedAt?: string | null;
  pendingFeedback?: string | null;
  sourceSessionId?: string;
  archivedAt?: string | null;
  category?: 'work' | 'test';
  sourceContext?: { kind: 'dsh_snapshot'; file: string; sha256: string; capturedAt: string; title: string; sessionId: string } | null;
  materials?: Material[];
}
export interface Material {
  id: string; name: string; relativePath: string; size: number; sha256: string; importedAt: string;
  integrity?: 'verified' | 'changed' | 'missing' | 'unsafe';
}
export interface MaterialList {
  taskId: string; locked: boolean;
  limits: { maxFileBytes: number; maxTaskBytes: number; maxFiles: number };
  materials: Material[];
}
export interface Run {
  contextTaskId?: string | null;
  id: string; roomId: string; memberId: string; taskId: string | null;
  meetingId: string | null; stage: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted';
  summary: string; error: string | null; riskFlags: string[];
  warnings?: string[];
  executionStatus?: string; outputCheck?: TaskStepOutputCheck | null;
  hop: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
  exitCode: number | null; conversationId: string | null;
  runtime?: RuntimeDiagnostics;
  waitReason?: string;
}
export interface RunDetails {
  run: Run;
  waitReason: string;
  result: string;
  logTail: string;
}
export interface TaskProgress {
  taskId: string;
  active: boolean;
  runs: Run[];
  currentRuns: Array<Run & { waitReason?: string }>;
  coordination: Task['coordination'] | null;
  canReassign: boolean;
  canPause: boolean;
  remainingRepairs: number;
  reviewerExcludedIds: string[];
  totalRuns: number;
  omittedRuns: number;
  assistance?: TaskAssistanceRecord[];
  resume?: { available: boolean; reusableSteps: number; totalSteps: number; reason: string };
}
export interface Artifact {
  id: string; taskId: string; name: string; relativePath: string;
  size: number; sha256: string; updatedAt: string;
}
export interface Meeting {
  id: string; roomId: string; objective: string; memberIds: string[];
  phase: 'independent' | 'challenge' | 'synthesis' | 'complete' | 'blocked' | 'cancelled';
  summary: string; createdAt: string;
}
export interface Settings {
  paused: boolean; proxy: string; maxParallel: number; maxHops: number;
  repairLimit: number; runTimeoutMinutes: number;
  managedTeam?: ManagedTeam | null;
}
export interface ManagedTeam {
  ownerId: string; workerIds: string[]; reviewerId: string | null;
  verification: Verification | null; autoDeliver: boolean;
}
export interface Bootstrap {
  workspace: Settings & {
    name: string; root: string; workspacesPath: string; activeRuns: number;
    controllerLastSeen: string | null;
  };
  members: Member[]; rooms: Room[]; tasks: Task[]; runs: Run[];
  artifacts: Artifact[]; meetings: Meeting[];
  externalSessions: ExternalSession[];
  archived: { tasks: number; rooms: number };
}
export interface ExternalSession {
  id?: string; sessionId: string; title: string; workspace: string;
  activity: 'running' | 'idle' | 'stopped' | 'unknown';
  formatVersion: number; eventCount: number; partial: boolean;
  updatedAt: string; lastEventAt: string | null; lastTool: string;
  summary: string; lastRequest: string; model: string; provider: string;
  mode: 'observe'; ownership: 'desktop'; canControl: false; syncedAt?: string;
}
