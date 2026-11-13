import type { BusinessSnapshot, ContentItem } from '../types';
import { currentContentVersion, publicationAttemptForDisplay, unresolvedSubmission } from './businessState.ts';
import { preferredProjectContent } from './projectWorkspaceState.ts';

/** A submitted manuscript stays attached to its recorded version while its result is unresolved. */
export function projectOutputDisplay(state: BusinessSnapshot, item: ContentItem) {
  const attempt = publicationAttemptForDisplay(state.attempts, item.id);
  const frozen = unresolvedSubmission(attempt);
  const versionId = frozen ? attempt!.versionId : currentContentVersion(item);
  const revision = state.contentRevisions.find(entry => entry.id === versionId
    && entry.contentId === item.id && entry.projectId === item.projectId) || null;
  return {
    item, revision, versionId, frozen,
    title: revision?.title || (frozen ? '提交时的内容' : item.title || '内容准备中'),
    body: revision?.body || (frozen ? '提交时的内容版本尚未读取，打开内容后继续核对。' : '完整内容尚未形成，已有工作记录可以展开查看。'),
  };
}

export function currentProjectOutput(state: BusinessSnapshot, projectId: string, selectedContentId?: string | null) {
  const selected = selectedContentId ? state.contentItems.find(item => item.projectId === projectId && item.id === selectedContentId) : null;
  const preferredId = selected ? null : preferredProjectContent(state, projectId);
  const item = selected || state.contentItems.find(entry => entry.projectId === projectId && entry.id === preferredId);
  return item ? projectOutputDisplay(state, item) : null;
}
