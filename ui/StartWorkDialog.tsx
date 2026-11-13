import { ArrowRight, CheckSquare, FolderOpen, X } from 'lucide-react';
import './workflow.css';

export default function StartWorkDialog({ onClose, onTask, onProject }: {
  onClose: () => void; onTask: () => void; onProject: () => void;
}) {
  return <div className="modal-overlay" onClick={onClose}>
    <section className="modal-content start-work-dialog" role="dialog" aria-modal="true" aria-labelledby="start-work-title" onClick={event => event.stopPropagation()}>
      <header className="modal-header"><div><h2 className="modal-title" id="start-work-title">开始新工作</h2><p className="text-muted">告诉团队你想完成什么。</p></div>
        <button className="btn btn-icon-only btn-secondary" aria-label="关闭新工作选择" onClick={onClose}><X size={16} /></button></header>
      <div className="modal-body start-work-options">
        <button className="start-work-option" onClick={onTask}><CheckSquare size={23} /><span><strong>完成一次任务</strong><small>例如写一份报告、修改代码。交代目标后，由负责人安排和交付。</small></span><ArrowRight size={18} /></button>
        <button className="start-work-option" onClick={onProject}><FolderOpen size={23} /><span><strong>持续运营内容</strong><small>围绕一个小红书账号持续制作图文、审稿与修改，发布前由你确认。</small></span><ArrowRight size={18} /></button>
      </div>
    </section>
  </div>;
}
