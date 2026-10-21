import { api } from '../../api.ts';

type MessageInput = { body: string; recipientIds: string[]; analysisOnly: boolean; taskId?: string };
type PendingDraft = {
  values: Record<string, string>;
  setField: (name: string, value: string) => void;
  flush: () => Promise<boolean>;
};

// Only a receipt identifier is persisted. Restoring a draft never restores
// execution permissions or silently sends a message.
export async function deliverRoomMessage(roomId: string, input: MessageInput, draft: PendingDraft,
  validationIssue: string, transport: Pick<typeof api, 'getMessageReceipt' | 'sendMessage'> = api) {
  const pendingId = draft.values.sendRequestId;
  if (pendingId) {
    const receipt = await transport.getMessageReceipt(roomId, pendingId);
    if (receipt.message) {
      const canonical = JSON.stringify({ roomId, actor: 'user', body: input.body.trim(),
        recipientIds: [...new Set(input.recipientIds)].sort(), taskId: input.taskId || null, analysisOnly: input.analysisOnly });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return { message: receipt.message, clearBody: fingerprint === receipt.fingerprint };
    }
  }
  if (validationIssue) throw new Error(validationIssue);
  const requestId = pendingId || crypto.randomUUID();
  draft.setField('sendRequestId', requestId);
  if (!await draft.flush()) throw new Error('发送请求尚未保存，请重试；消息仍保留在草稿中。');
  const message = await transport.sendMessage(roomId, input.body.trim(), input.recipientIds, input.analysisOnly, input.taskId, requestId);
  return { message, clearBody: true };
}
