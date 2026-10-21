import { redact } from './safety.mjs';

export function diagnosticText(value, limit = 2000) {
  return redact(String(value || ''))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|token|secret|password|signature)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|secret|token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, '$1[REDACTED]')
    .slice(0, limit);
}

export function protocolError(cause) {
  const details = [];
  const visit = (value, depth = 0) => {
    if (depth > 3) return;
    if (typeof value === 'string') { details.push(diagnosticText(value)); return; }
    if (!value || typeof value !== 'object') return;
    // Ignore request/config/header payloads; only retain explicit error fields.
    for (const key of ['message', 'details', 'detail', 'reason', 'error', 'cause']) visit(value[key], depth + 1);
  };
  visit(cause?.data);
  if (!details.length) visit(cause?.cause);
  const message = diagnosticText(cause?.message || cause || '客户端返回未知错误');
  const detail = [...new Set(details.filter((value) => value !== message))].join('；').slice(0, 2000);
  return { code: typeof cause?.code === 'number' || typeof cause?.code === 'string' ? diagnosticText(cause.code, 80) : null,
    message, detail, text: detail ? `${message}：${detail}` : message };
}

export function runtimeHint(error, stage) {
  if (/no adapter registered|unknown provider/i.test(error)) return '当前配置没有注册会话使用的模型供应商。检查成员的 DSH 配置来源，并重新检查接入。';
  if (/not resumable|unknown session|session.*not found|cwd.*(?:match|mismatch)/i.test(error)) return '原生会话已不可恢复或目录不一致。可在聊天室明确重置该成员会话后再次发送，历史记录会保留。';
  if (/lock|already active|in use/i.test(error) && stage === 'resume') return '原生会话正被占用。结束对应官方客户端中的运行后重试；系统不会强行接管或重复发送。';
  if (/模型未唯一匹配|unknown model|no configured model|model.*not found/i.test(error)) return '当前模型无法使用。请在成员设置中选择官方 DSH 已配置的有效模型，再重试；原会话和历史上下文会保留。';
  if (/401|403|unauth|credential|login|登录|api.?key/i.test(error)) return '请在官方 CLI 中检查登录和模型授权，然后重新检查接入。';
  if (/certificate|TLS|self.signed/i.test(error)) return '模型服务的 TLS 校验未通过。请检查官方客户端的证书配置，不要关闭证书校验。';
  if (/\b(?:502|503|504)\b/i.test(error)) return '本次请求收到网关错误。可稍后重试；若官方客户端能正常使用，请对照模型配置和工作区代理。';
  if (/timeout|timed.?out|超时/i.test(error) && stage === 'prompt') return '本次请求超过等待时间。可查看作业日志后重试，或在工作区设置调整等待时间；原会话和记录已保留。';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|connect/i.test(error)) return '请检查模型服务地址、服务状态和成员使用的代理。';
  if (stage === 'model') return '检查成员的模型名称是否出现在接入检查返回的模型列表中。';
  if (stage === 'initialize') return 'CLI 已启动但协议握手失败，请检查客户端版本和配置来源。';
  return '查看失败阶段和客户端返回的详情，修正后重试。';
}
