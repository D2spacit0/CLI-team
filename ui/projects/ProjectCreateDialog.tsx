import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessProject } from '../types';
import { useTaskDraft } from '../taskDrafts';
import { isMemberRunnable } from '../memberAvailability';

export default function ProjectCreateDialog({ bootstrap, onClose, onCreated, onMembers, onBusy }: {
  bootstrap: Bootstrap; onClose: () => void; onCreated: (project: BusinessProject) => Promise<void>;
  onMembers: () => void; onBusy: (busy: boolean) => void;
}) {
  const members = bootstrap.members.filter(isMemberRunnable);
  const managed = bootstrap.workspace.managedTeam;
  const defaults = useRef((() => {
    const owner = members.find((member) => member.id === managed?.ownerId)
      || members.find((member) => member.permission === 'edit' && member.role === 'builder');
    const reviewer = members.find((member) => member.id === managed?.reviewerId && member.id !== owner?.id)
      || members.find((member) => member.role === 'reviewer' && member.id !== owner?.id)
      || members.find((member) => member.id !== owner?.id);
    return {
      name: '', objective: '', brief: '', ownerId: owner?.id || '',
      memberIds: JSON.stringify(members.slice(0, 8).map((member) => member.id)),
      reviewerId: reviewer?.id || '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', requestId: '',
    };
  })()).current;
  const draft = useTaskDraft(bootstrap.workspace.root, { kind: 'new-project' }, defaults);
  const fields = { ...defaults, ...draft.values };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const owner = members.find((member) => member.id === fields.ownerId);
  const reviewer = members.find((member) => member.id === fields.reviewerId);
  const parseMembers = () => {
    try { const ids: unknown = JSON.parse(fields.memberIds); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; }
    catch { return []; }
  };
  const memberIds = [...new Set([...parseMembers(), fields.ownerId, fields.reviewerId].filter(Boolean))];
  const teamError = !owner || owner.permission !== 'edit' ? '请在设置中配置一位可编辑文件的负责人。'
    : !reviewer || reviewer.id === owner.id ? '需要一位与负责人不同的成员审稿。' : '';
  const operation = (value: boolean) => { lock.current = value; setBusy(value); onBusy(value); };
  const leave = async (next = onClose) => {
    if (lock.current) return;
    operation(true);
    try {
      if (!await draft.flush()) { setError('填写内容尚未保存，请重试保存后离开。'); return; }
      next();
    } finally { operation(false); }
  };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    form.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void leave(); }
      if (event.key !== 'Tab' || !form.current) return;
      const focusable = [...form.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')]
        .filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); onBusy(false); };
  }, []);
  const create = async () => {
    if (lock.current || !draft.loaded) return;
    if (teamError) { setError(teamError); return; }
    operation(true); setError('');
    try {
      const requestId = fields.requestId || crypto.randomUUID();
      draft.setField('requestId', requestId);
      if (!await draft.flush()) throw new Error('创建请求还未保存，请重试。');
      const project = await api.createProject({
        requestId, name: fields.name.trim(), objective: fields.objective.trim(), brief: fields.brief.trim(),
        moduleId: 'xiaohongshu', ownerId: fields.ownerId, memberIds, reviewerId: fields.reviewerId,
        timeZone: fields.timeZone, start: true,
      });
      await draft.clear();
      await onCreated(project);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目创建失败，请重试同一请求。'); }
    finally { operation(false); }
  };
  const frozen = busy || !draft.loaded || Boolean(fields.requestId);
  return <div className="modal-overlay business-dialog-overlay">
    <div className="modal-content business-create-dialog" role="dialog" aria-modal="true" aria-labelledby="business-create-title">
      <form ref={form} onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="modal-header">
          <div><h2 id="business-create-title" className="modal-title">建立业务项目</h2><p className="business-muted">交代长期目标，团队负责拆分工作与形成整稿。</p></div>
          <button type="button" className="btn btn-icon-only btn-secondary" aria-label="保存草稿并关闭" disabled={busy} onClick={() => void leave()}><X size={16} /></button>
        </div>
        <div className="modal-body business-form">
          <div className="business-module-note"><span>小红书 · 图文运营</span><span>一个项目绑定一个账号</span></div>
          <label className="form-group"><span className="form-label">项目名称</span>
            <input className="form-input" value={fields.name} maxLength={100} placeholder="例如：户外装备知识分享" required disabled={frozen} onChange={(event) => draft.setField('name', event.target.value)} /></label>
          <label className="form-group"><span className="form-label">希望团队持续做什么</span>
            <textarea className="form-textarea" value={fields.objective} maxLength={6000} rows={4} placeholder="说明面向谁、提供什么价值，以及希望达成的结果。" required disabled={frozen} onChange={(event) => draft.setField('objective', event.target.value)} /></label>
          <label className="form-group"><span className="form-label">已有资料与内容要求 <span className="business-muted">选填</span></span>
            <textarea className="form-textarea" value={fields.brief} maxLength={12000} rows={3} placeholder="品牌与账号背景、表达偏好、信息来源、不能使用的说法……材料文件可在项目资料中补充。" disabled={frozen} onChange={(event) => draft.setField('brief', event.target.value)} /></label>
          <div className="business-team-summary"><strong>项目团队</strong><span>负责人：{owner?.name || '待配置'} · 审稿：{reviewer?.name || '待配置'}</span>
            <details><summary>调整项目成员</summary><div className="business-form business-team-fields">
              <label className="form-group"><span className="form-label">负责人</span><select className="form-select" disabled={frozen} value={fields.ownerId} onChange={(event) => draft.setField('ownerId', event.target.value)}>
                <option value="">请选择负责人</option>{members.filter((member) => member.permission === 'edit').map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select></label>
              <label className="form-group"><span className="form-label">独立审稿成员</span><select className="form-select" disabled={frozen} value={fields.reviewerId} onChange={(event) => draft.setField('reviewerId', event.target.value)}>
                <option value="">请选择审稿成员</option>{members.filter((member) => member.id !== fields.ownerId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select></label>
              <fieldset className="business-member-choices" disabled={frozen}><legend>参与成员</legend>{members.map((member) => <label key={member.id}>
                <input type="checkbox" checked={memberIds.includes(member.id)} disabled={[fields.ownerId, fields.reviewerId].includes(member.id)} onChange={(event) => draft.setField('memberIds', JSON.stringify(event.target.checked ? [...memberIds, member.id] : memberIds.filter((id) => id !== member.id)))} />{member.name}
              </label>)}</fieldset>
              <label className="form-group"><span className="form-label">排期时区</span><input className="form-input" value={fields.timeZone} disabled={frozen} onChange={(event) => draft.setField('timeZone', event.target.value)} /></label>
            </div></details>
          </div>
          {teamError && <div className="business-notice attention"><AlertCircle size={16} /><div>{teamError} <button type="button" className="business-text-button" onClick={() => void leave(onMembers)}>去配置成员</button></div></div>}
          <p className="business-muted">团队会制作真实图文、互审与修改。发布前需你确认当前整稿；账号尚未接入时也可以先准备内容。</p>
          {(error || draft.error) && <div className="business-notice danger" role="alert"><AlertCircle size={16} /><span>{error || draft.error}</span></div>}
          {fields.requestId && !busy && <p className="business-muted">创建结果尚未确认，重试会核对同一请求，避免重复建立项目。</p>}
        </div>
        <div className="modal-footer"><span className="business-muted">{draft.saving ? '正在保存填写内容' : draft.restored ? '已恢复填写草稿' : '填写内容自动保存'}</span>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void leave()}>稍后继续</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.loaded || Boolean(teamError) || !fields.name.trim() || !fields.objective.trim()}>{busy ? '正在建立项目' : fields.requestId ? '核对并继续创建' : '建立项目并开始'}<ArrowRight size={14} /></button>
        </div>
      </form>
    </div>
  </div>;
}
