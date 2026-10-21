import type { Run } from './types';
import { useState } from 'react';
import { api } from './api';

const riskNames: Record<string, string> = {
  process_error: '执行进程出错', provider_error: '模型客户端返回错误',
  connection_failed: '客户端入口或接入配置检查失败',
  cli_input_too_long: '客户端参数超过系统长度限制，请改用标准输入或 DSH 成员',
  permission_denied: '操作被权限检查拒绝', out_of_scope_write: '检测到任务目录外的写入目标',
  output_limit: '输出超过处理上限', missing_terminal_event: '未收到客户端正常结束事件',
  unstructured_report: '缺少符合协议的结构化回执', relay_context_changed: '接力来源材料被修改',
  input_integrity_changed: '输入材料完整性检查失败', read_only_workspace_changed: '只读阶段检测到任务文件变化',
  symlink_present: '任务目录包含符号链接，文件检查未能完整执行', tool_failed: '工具调用失败',
  repeated_tool_failure: '工具连续调用失败', analysis_tool_used: '只读分析阶段调用了受限工具',
  cancelled: '执行已取消', timeout: '执行超时', dsh_missing_stop_reason: 'DSH 未报告结束原因',
};
const stageNames: Record<string, string> = { entry: '检查程序入口', configuration: '读取模型配置', initialize: '协议握手',
  session: '创建原生会话', resume: '恢复原生会话', model: '选择模型', prompt: '执行模型请求', process: '客户端进程', complete: '本轮结束' };
const sessionNames: Record<string, string> = { pending: '尚未确认', created: '已创建', resumed: '已恢复', failed: '未能建立', unconfirmed: '未确认' };

function SessionReset({ run }: { run: Run }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const reset = async () => {
    setBusy(true); setError('');
    try {
      await api.resetRunConversation(run);
      setResult('会话映射已重置。下次发送时按成员当前模型设置新建会话，原会话和聊天记录保留。');
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '重置失败'); }
    finally { setBusy(false); }
  };
  if (result) return <p role="status">{result}</p>;
  return <div style={{ margin: '12px 0' }}>
    {!confirming ? <button className="btn btn-sm btn-secondary" onClick={() => setConfirming(true)}>重置此作业的成员会话</button>
      : <div className="task-prepared-note">
        <p>解除此作业对应的成员会话映射，保留原生会话及历史。下次由你发送时新建会话；当前任务不会重发。</p>
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void reset()}>{busy ? '正在重置…' : '确认重置会话'}</button>
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
      </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export default function RunDiagnostics({ run }: { run: Run }) {
  return <div style={{ overflowWrap: 'anywhere' }}>
    <div className="form-label">机器执行记录</div>
    <p>进程退出码：{run.exitCode ?? '未提供'}{run.error ? ` · 错误：${run.error}` : ''}</p>
    {run.runtime && <div>
      <p>接入方式：{run.runtime.transport} · {run.error ? '失败阶段' : '运行阶段'}：{stageNames[run.runtime.stage] || run.runtime.stage}
        {run.runtime.method && <> · <code>{run.runtime.method}</code></>}{run.runtime.code && <> · 错误代码 {run.runtime.code}</>}</p>
      {(run.runtime.requestedModel || run.runtime.selectedModel) && <p>配置模型：{run.runtime.requestedModel || '官方默认'} · 实际选择：{run.runtime.selectedModel || '尚未确认'}</p>}
      {run.runtime.modelRecovery && <p>{run.runtime.modelRecovery.state === 'applied'
        ? `旧模型 ${run.runtime.modelRecovery.from} 已不可用，本轮已切换至 ${run.runtime.modelRecovery.to}，原会话和历史上下文保留。`
        : `旧模型 ${run.runtime.modelRecovery.from} 已不可用，尚未确认切换至 ${run.runtime.modelRecovery.to}；本轮未发送消息。`}</p>}
      {run.runtime.session && <p>原生会话：{sessionNames[run.runtime.session.state]}{run.runtime.session.id && <> · <code>{run.runtime.session.id}</code></>}</p>}
      {run.runtime.session?.requestedId && !run.runtime.session.id && <p className="text-muted">尝试恢复的会话：<code>{run.runtime.session.requestedId}</code></p>}
      {run.runtime.promptSubmitted === false && <p>本轮尚未发送任务给模型。</p>}
      {run.runtime.hint && <p>{run.runtime.hint}</p>}
      {Boolean(run.runtime.configurationSources?.length) && <details><summary>模型配置来源</summary>
        {run.runtime.configurationSources?.map((source) => <p key={source}><code>{source}</code></p>)}
      </details>}
    </div>}
    {['failed', 'blocked', 'cancelled', 'interrupted'].includes(run.status) &&
      (run.runtime?.session?.requestedId || run.runtime?.session?.id || run.conversationId) && <SessionReset key={run.id} run={run} />}
    {run.outputCheck && <div>
      <p><strong>步骤交付结构检查：{{ passed: '该次检查通过', failed: '未通过', not_configured: '未配置' }[run.outputCheck.status]}</strong></p>
      {run.executionStatus === 'succeeded' && run.outputCheck.status === 'failed' && <p className="text-muted">成员进程已结束，交付未满足约定，任务已阻塞；退出码为 0 不能代替交付检查。</p>}
      <p className="text-muted">{run.outputCheck.summary} · 检查于 {new Date(run.outputCheck.checkedAt).toLocaleString()}</p>
      {Boolean(run.outputCheck.issues?.length) && <ul>{run.outputCheck.issues?.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>}
    </div>}
    {run.riskFlags.length > 0 ? <ul>{run.riskFlags.map((flag) => <li key={flag}>
      {riskNames[flag] || (flag.startsWith('dsh_') ? 'DSH 未正常完成本轮执行' : '未识别的机器检查标记，请查看日志')} <code>{flag}</code>
    </li>)}</ul> : <p className="text-muted">未记录机器拦截标记；这不代表任务已通过验收。</p>}
    {run.summary && <details><summary>作业摘要（可能包含成员自述，不作为验收证据）</summary><p className="task-summary">{run.summary}</p></details>}
  </div>;
}
