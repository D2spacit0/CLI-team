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

export interface BusinessAccount {
  id: string; name?: string; label?: string; platform?: string; status?: string;
  connectorVersion?: string;
}
export interface BusinessProject {
  id: string; name: string; objective: string; moduleId: string; moduleVersion?: string;
  brief: string; briefVersion: number; revision: number;
  ownerId: string; memberIds: string[]; reviewerId: string | null;
  timeZone: string; timezone?: string;
  status: 'active' | 'paused' | 'attention' | 'archived';
  account: BusinessAccount | null;
  limits: { dailyCliCalls: number; maxPending: number; maxAttempts: number };
  materials?: BusinessMaterial[]; createdAt: string; updatedAt?: string; waitReason?: string;
  blockers?: string[];
}
export interface BusinessMaterial {
  id: string; name: string; sha256: string; size: number; source?: string;
  importedAt?: string; createdAt?: string;
}
export interface BusinessSource { label: string; url?: string; kind?: string }
export interface ProjectFact {
  id: string; projectId: string; type: 'fact' | 'judgment' | 'preference';
  content: string; sources: BusinessSource[]; status: 'proposed' | 'adopted' | 'superseded';
  revision: number; proposedBy?: string; adoptedBy?: string; createdAt: string;
}
export interface ProductionCycle {
  id: string; projectId: string; dateKey?: string; localDate?: string;
  objective?: string; status: string; createdAt: string; summary?: string;
}
export interface BusinessInputRef {
  kind: string; id: string; version?: string | number; revision?: string | number;
  versionId?: string; digest?: string; label?: string;
}
export interface BusinessWorkItem {
  id: string; projectId: string; cycleId?: string; contentId?: string | null;
  title?: string; objective: string; memberId: string; role?: string; kind?: string;
  status: string; generation: number; currentAttemptId?: string | null;
  attempts?: number; dependsOn?: string[]; dependencies?: string[]; inputRefs?: BusinessInputRef[];
  receiverId?: string; checkerId?: string; acceptanceCriteria?: string[];
  originalDueAt?: string | null; dueAt?: string | null; handoffStatus?: WorkHandoffStatus;
  resultDigest?: string; currentReceiptId?: string | null; runId?: string; threadId?: string | null;
  summary?: string; waitReason?: string; error?: string; createdAt: string; updatedAt?: string;
}
export type WorkHandoffStatus = 'assigned' | 'accepted' | 'received' | 'verified' | 'returned' | 'blocked' | 'cancelled';
export interface WorkHandoff {
  id: string; projectId: string; workItemId: string; generation: number; type: string;
  actorId?: string | null; recipientId?: string | null; runId?: string | null; receiptId?: string | null;
  resultDigest?: string | null; message?: string; evidenceType: string; createdAt: string;
}
export interface WorkReceipt {
  id: string; projectId: string; workItemId: string; generation: number;
  attemptId: string; runId: string; receiverId: string; createdAt: string;
  inputDigest: string; resultDigest: string; manifestHash: string;
  files: Array<{ relativePath: string; sha256: string; size: number; mime?: string }>;
  summary: string; checks: string[]; evidenceType: 'machine'; versionId: string | null;
}
export interface BusinessSkill {
  id: string; name: string; version: string; description: string; roles: string[];
  sourceUrl: string; digest: string;
}
export interface BusinessCollaboration {
  id: string; projectId: string; contentId?: string | null; workItemId?: string;
  sourceRunId?: string; sourceWorkItemId?: string; requesterId?: string;
  recipientId?: string; memberId?: string; type?: string; kind?: string; status: string;
  question?: string; body?: string; answer?: string; summary?: string;
  resolution?: string; inputRefs?: BusinessInputRef[]; createdAt: string; answeredAt?: string;
  answerRunId?: string; resolvedAt?: string; versionId?: string; evidenceType?: string;
}
export interface BusinessAction {
  id: string; projectId: string; contentId?: string; workItemId?: string;
  sourceRunId?: string; memberId?: string; type: string; status?: string;
  body?: string; summary?: string; question?: string; title?: string;
  reason?: string; createdAt: string;
  sourceWorkItemId?: string; generation?: number;
  input?: { message?: string; title?: string; objective?: string; question?: string; reason?: string; content?: string; tool?: string };
  result?: { id?: string; threadId?: string; workItemId?: string };
}
export interface ContentItem {
  id: string; projectId: string; title: string; status: string;
  currentRevisionId: string | null; currentDraftVersionId?: string | null;
  currentReviewVersionId?: string | null; generation: number; createdAt: string; updatedAt?: string;
}
export interface ContentImage {
  sha256: string; hash?: string; width: number; height: number; size: number;
  mime: string; source: string | BusinessSource; templateVersion?: string; name?: string;
}
export interface ContentSchedule {
  mode?: 'immediate' | 'scheduled'; kind?: 'immediate' | 'scheduled'; startsAt?: string;
}
export interface ContentRevision {
  id: string; contentId: string; projectId: string; revision: number; parentId: string | null;
  title: string; body: string; tags: string[]; topics?: string[]; images: ContentImage[];
  manifest: Record<string, unknown>; manifestHash: string; digest: string;
  inputRefs: BusinessInputRef[]; authorMemberIds: string[]; visibility: string;
  schedule?: ContentSchedule | null; changeSummary?: string; createdAt: string;
}
export interface ContentEligibility {
  id: string; contentId?: string; versionId: string; revision: number;
  status: 'pending' | 'eligible' | 'invalid'; reason?: string;
  checkIds: string[]; reviewIds: string[]; checkId?: string; reviewId?: string;
}
export interface ContentFinding { code?: string; message: string; severity?: string }
export interface ContentCheck {
  id: string; contentId: string; versionId: string; manifestHash: string;
  passed: boolean; findings: ContentFinding[]; createdAt: string; evidenceType: 'machine';
  status?: string; invalidatedAt?: string | null;
}
export interface ContentReview {
  id: string; memberId: string; contentId: string; versionId: string; manifestHash: string;
  verdict: 'approve' | 'changes_requested'; summary: string;
  findings?: (ContentFinding | string)[]; createdAt: string; evidenceType: 'agent_review';
  status?: string; sourceRunId?: string | null; invalidatedAt?: string | null;
  reusedFromReviewId?: string; evidenceReuse?: 'schedule_only';
}
export interface PublicationApproval {
  id: string; contentId: string; versionId: string; projectId?: string; status: string;
  approvalDigest: string; account?: BusinessAccount; approvedAt?: string; createdAt: string;
  startsAt?: string; endsAt?: string; reason?: string;
}
export interface PublicationAttempt {
  id: string; publicationId?: string; contentId: string; versionId: string; projectId?: string;
  status: string; submissionMayHaveOccurred: boolean; account?: BusinessAccount;
  createdAt: string; updatedAt?: string; summary?: string; reason?: string;
  error?: string; noteId?: string; noteUrl?: string; verificationBlocked?: string;
  evidence?: { noteId?: string; accountId?: string; verifiedAt?: string; noteUrl?: string; summary?: string };
}
export interface Publication {
  id: string; contentId: string; versionId: string; projectId?: string;
  status: string; approvalId?: string; attemptId?: string; createdAt: string;
}
export interface MetricValue {
  name: string; label?: string; value: number | null; status?: string;
  unavailableReason?: string; reason?: string; source?: string;
}
export interface MetricsSnapshot {
  id: string; projectId?: string; contentId?: string; noteId: string;
  collectedAt?: string; createdAt?: string; source?: string;
  metrics?: MetricValue[] | Record<string, number | null | MetricValue>;
  name?: string; value?: number | null; unavailableReason?: string;
}
export interface BusinessConnection {
  status: 'ready' | 'login_required' | 'unavailable';
  account?: BusinessAccount | null; version?: string; browserOpen?: boolean;
  reason?: string; message?: string; checkedAt?: string;
  capabilities?: Record<string, boolean | string | null>;
  gates?: Array<{ name: string; status: string; reason?: string }>;
}
export interface BusinessSnapshot {
  projects: BusinessProject[]; projectFacts: ProjectFact[]; productionCycles: ProductionCycle[];
  projectMaterials: Array<BusinessMaterial & { projectId: string }>;
  workItems: BusinessWorkItem[]; contentItems: ContentItem[]; contentRevisions: ContentRevision[];
  contentEligibilities: ContentEligibility[]; contentChecks: ContentCheck[]; reviews: ContentReview[];
  collaborationThreads: BusinessCollaboration[]; actions: BusinessAction[];
  workHandoffs: WorkHandoff[]; workReceipts: WorkReceipt[]; skillCatalog: BusinessSkill[];
  publications: Publication[]; approvals: PublicationApproval[]; attempts: PublicationAttempt[];
  metrics: MetricsSnapshot[]; connection: BusinessConnection | null;
}
export interface PublicationPreview {
  contentId: string; versionId: string; revision: ContentRevision; content?: ContentItem;
  approvalDigest: string; canApprove: boolean; blockers: string[]; account: BusinessAccount | null;
  timeWindow: { kind: string; startsAt: string | null; endsAt: string | null; display: string };
  payload: { title: string; body: string; tags: string[]; images: Array<Pick<ContentImage, 'sha256' | 'width' | 'height' | 'mime'> & { index?: number }>; visibility: string };
  connector: { version?: string; status: string; capabilities?: Record<string, boolean | string | null> };
  eligibility?: ContentEligibility; checks?: ContentCheck[]; reviews?: ContentReview[];
  approval: PublicationApproval | null; attempt: PublicationAttempt | null;
}
