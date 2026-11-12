import { trustedSender } from './workspace.mjs';

/** Main-process-only ceremony; renderer input never supplies human confirmation. */
export async function requestNativePublicationApproval({ event, window, backend, getContext, showMessageBox,
  contentId, versionId, expectedDigest }) {
  const original = { ...getContext() };
  const validate = () => {
    const current = getContext();
    if (!trustedSender(event, window, current.origin)) throw new Error('拒绝来自其他页面的发布确认。');
    if (current.generation !== original.generation || current.workspace !== original.workspace ||
        backend.state !== original.backendState || current.switching || current.quitting) {
      throw new Error('页面、工作区或后台实例已经改变，请重新查看整稿。');
    }
  };
  validate();
  let nonce;
  try {
    const reply = await backend.request('publication:begin', { contentId, versionId, expectedDigest });
    nonce = reply.result.nonce;
    const summary = reply.result.summary;
    validate();
    const timing = summary.timeWindow.kind === 'immediate' ? '批准后10分钟内' :
      `${new Date(summary.timeWindow.startsAt).toLocaleString('zh-CN')} 至 ${new Date(summary.timeWindow.endsAt).toLocaleTimeString('zh-CN')}`;
    const result = await showMessageBox(window, { type: 'question', title: '确认发布当前整稿',
      message: `将「${summary.title}」发布到 ${summary.account.name || summary.account.id}？`,
      detail: `账号：${summary.account.id}\n图片：${summary.imageCount} 张（保持预览顺序）\n可见范围：公开\n执行窗口：${timing}\n版本：${summary.versionId}\n\n请确认工作台中已预览的完整图文。发布开始后可能已提交，不能直接撤回。`,
      buttons: ['返回整稿', '批准发布'], defaultId: 0, cancelId: 0, noLink: true });
    validate();
    if (result.response !== 1) { await backend.request('publication:cancel', { nonce }); return { cancelled: true }; }
    return (await backend.request('publication:confirm', { nonce })).result;
  } finally {
    if (nonce && backend.state === original.backendState && backend.child?.connected) void backend.request('publication:cancel', { nonce }).catch(() => {});
  }
}
