import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { api } from '../api';
import type { Bootstrap, BusinessProject } from '../types';
import { useTaskDraft } from '../taskDrafts';
import { isMemberRunnable, memberUnavailableReason } from '../memberAvailability';
import { missingProjectRoles, projectTeamDefaults } from './projectTeamDefaults';

export default function ProjectCreateDialog({ bootstrap, onClose, onCreated, onMembers, onBusy }: {
  bootstrap: Bootstrap; onClose: () => void; onCreated: (project: BusinessProject) => Promise<void>;
  onMembers: () => void; onBusy: (busy: boolean) => void;
}) {
  const members = bootstrap.members.filter(isMemberRunnable);
  const managed = bootstrap.workspace.managedTeam;
  const defaults = useRef((() => {
    const team = projectTeamDefaults(bootstrap.members, managed);
    return {
      name: '', objective: '', brief: '', ownerId: team.ownerId,
      memberIds: JSON.stringify(team.memberIds),
      reviewerId: team.reviewerId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', requestId: '',
    };
  })()).current;
  const draft = useTaskDraft(bootstrap.workspace.root, { kind: 'new-project' }, defaults);
  const fields = { ...defaults, ...draft.values };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const hydratedTeam = useRef(false);
  useEffect(() => {
    if (!draft.loaded || hydratedTeam.current) return;
    hydratedTeam.current = true;
    const changes = missingProjectRoles(draft.values, projectTeamDefaults(bootstrap.members, managed));
    if (Object.keys(changes).length) draft.setValues(changes);
  }, [draft.loaded]);
  const owner = members.find((member) => member.id === fields.ownerId);
  const reviewer = members.find((member) => member.id === fields.reviewerId);
  const ownerChoices = members.filter((member) => member.permission === 'edit');
  const reviewerChoices = members.filter((member) => member.id !== fields.ownerId);
  const savedOwner = bootstrap.members.find((member) => member.id === fields.ownerId);
  const savedReviewer = bootstrap.members.find((member) => member.id === fields.reviewerId);
  const parseMembers = () => {
    try { const ids: unknown = JSON.parse(fields.memberIds); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; }
    catch { return []; }
  };
  const memberIds = [...new Set([...parseMembers(), fields.ownerId, fields.reviewerId].filter(Boolean))];
  const unavailableMemberIds = memberIds.filter(id => !members.some(member => member.id === id));
  const teamError = !owner || owner.permission !== 'edit' ? '请展开“调整项目成员”，选择可编辑文件的负责人，或去配置成员。'
    : !reviewer || reviewer.id === owner.id ? '请展开“调整项目成员”，选择与负责人不同的独立审稿成员，或去配置成员。'
      : unavailableMemberIds.length ? '团队中保留了不可用或已缺失的成员。请展开“调整项目成员”取消勾选以移除，或去配置成员恢复后继续。' : '';
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
    const dialog = form.current?.closest<HTMLElement>('[role="dialog"]');
    const workspace = dialog?.closest<HTMLElement>('.business-workspace');
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (active && active !== document.body && active !== document.documentElement && !dialog?.contains(active)) restoreFocusTo.current = active;
    const previous = restoreFocusTo.current;
    const focusable = (element: HTMLElement | null | undefined): element is HTMLElement => Boolean(element?.isConnected
      && element !== document.body && element !== document.documentElement && !element.closest('[inert], [hidden], [aria-hidden="true"]')
      && !element.matches(':disabled') && element.getClientRects().length && getComputedStyle(element).visibility === 'visible');
    const input = form.current?.querySelector<HTMLInputElement>('input');
    const initial = focusable(input) ? input : form.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    initial?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !dialog?.isConnected || dialog.closest('[inert]')) return;
      if (document.activeElement && document.activeElement !== document.body && !dialog.contains(document.activeElement)) return;
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void leave(); }
      if (event.key !== 'Tab' || !form.current) return;
      const focusable = [...form.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')]
        .filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      onBusy(false);
      // Wait for the closing commit to remove inert. A route change or a new dialog owns its own focus.
      requestAnimationFrame(() => {
        if (!workspace?.isConnected || dialog?.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body && !dialog?.contains(active)) return;
        const foreground = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')]
          .some(focusable);
        if (foreground) return;
        const target = [previous, ...document.querySelectorAll<HTMLElement>('.header-actions [aria-label="开始新工作"]')].find(focusable);
        if (focusable(target)) target.focus({ preventScroll: true });
      });
    };
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
          <div><h2 id="business-create-title" className="modal-title">持续运营内容</h2><p className="business-muted">写下目标，团队会在这个项目里持续制作、审稿与修改。</p></div>
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
          <div className="business-team-summary"><strong>项目团队</strong><span>负责人：{savedOwner?.name || (fields.ownerId ? '原负责人已缺失' : '待配置')} · 审稿：{savedReviewer?.name || (fields.reviewerId ? '原审稿成员已缺失' : '待配置')}</span>
            <p className="workflow-default-team-note">{managed ? teamError ? '已保留默认团队，请补齐或调整不可用成员。' : '已沿用默认团队，可以按需调整。' : teamError ? '请补齐负责人、独立审稿与参与成员。' : '已推荐负责人和独立审稿成员，可以按需调整。'}</p>
            <details><summary>调整项目成员</summary><div className="business-form business-team-fields">
              <label className="form-group"><span className="form-label">负责人</span><select className="form-select" disabled={frozen} value={fields.ownerId} onChange={(event) => draft.setValues({ ownerId: event.target.value, memberIds: JSON.stringify(memberIds) })}>
                <option value="">请选择负责人</option>
                {fields.ownerId && !ownerChoices.some((member) => member.id === fields.ownerId) && <option value={fields.ownerId} disabled>{savedOwner?.name || '原负责人'} · {memberUnavailableReason(savedOwner, { requireEdit: true }) || '不可用'}（请更换）</option>}
                {ownerChoices.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select></label>
              <label className="form-group"><span className="form-label">独立审稿成员</span><select className="form-select" disabled={frozen} value={fields.reviewerId} onChange={(event) => draft.setValues({ reviewerId: event.target.value, memberIds: JSON.stringify(memberIds) })}>
                <option value="">请选择审稿成员</option>
                {fields.reviewerId && !reviewerChoices.some((member) => member.id === fields.reviewerId) && <option value={fields.reviewerId} disabled>{savedReviewer?.name || '原审稿成员'} · {fields.reviewerId === fields.ownerId ? '不能与负责人相同' : memberUnavailableReason(savedReviewer) || '不可用'}（请更换）</option>}
                {reviewerChoices.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select></label>
              <fieldset className="business-member-choices" disabled={frozen}><legend>参与成员</legend>{members.map((member) => <label key={member.id}>
                <input type="checkbox" checked={memberIds.includes(member.id)} disabled={[fields.ownerId, fields.reviewerId].includes(member.id)} onChange={(event) => draft.setField('memberIds', JSON.stringify(event.target.checked ? [...memberIds, member.id] : memberIds.filter((id) => id !== member.id)))} />{member.name}
              </label>)}{unavailableMemberIds.map((id) => {
                const member = bootstrap.members.find((entry) => entry.id === id);
                const requiredRole = [fields.ownerId, fields.reviewerId].includes(id);
                return <label key={id} title={id}><input type="checkbox" checked disabled={requiredRole}
                  onChange={() => draft.setField('memberIds', JSON.stringify(memberIds.filter((entry) => entry !== id)))} />
                  <span>{member?.name || '已缺失成员'}<small className="business-muted"> · {memberUnavailableReason(member)}，{requiredRole ? '请先更换上方角色' : '取消勾选可移除'}</small></span>
                </label>;
              })}</fieldset>
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
