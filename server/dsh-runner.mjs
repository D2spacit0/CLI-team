import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable, Transform } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { buildInvocation, parseReport } from './adapters.mjs';
import { dshDesktopInfo, usesDshLiveConfig } from './dsh-installation.mjs';
import { childEnvironment, killChild, redact, resolveInside } from './safety.mjs';
import { dshHome } from './dsh-sessions.mjs';
import { describeDshConfiguration } from './dsh-config.mjs';
import { diagnosticText, protocolError, runtimeHint } from './runtime-diagnostics.mjs';
import { validateDshModelRecovery } from './dsh-resume-model.mjs';

export function prepareDshRuntime(options, member) {
  const key = /^[a-zA-Z0-9-]{1,100}$/.test(member.id || '') ? member.id
    : createHash('sha256').update(JSON.stringify([member.executable, member.prefixArgs || []])).digest('hex').slice(0, 20);
  const directory = path.join(options.dataDir || path.dirname(path.dirname(options.streamLog)), 'dsh-runtime', key);
  const home = path.join(directory, 'home');
  fs.mkdirSync(home, { recursive: true });
  const patchFile = path.join(directory, options.analysisOnly ? 'discussion.cordis.patch.yml' : 'team.cordis.patch.yml');
  // Reuse the official credential/settings providers by path, never copy their contents.
  const source = options.sourceHome || dshHome();
  const configuration = describeDshConfiguration(member, source);
  const liveConfig = usesDshLiveConfig(member);
  const recovery = liveConfig && options.conversationId ? {
    sessionId: options.conversationId, requestedModel: member.model?.trim() || null,
    // Match the official ACP new-session selection: provider/model, with the
    // new model's adapter defaults rather than the old model's reasoning mode.
    defaultSelection: configuration.defaultModel ? { ...configuration.bootstrapRoute } : null,
    receiptFile: path.join(directory, `resume-${randomUUID()}.json`),
  } : null;
  const patch = [
    { id: 'credentials', config: { path: path.join(source, '.credentials.yaml'), dshHome: source, watch: false } },
    { id: 'session-title-llm', disabled: true },
  ];
  if (configuration.sources.length) {
    patch.push({ id: 'settings', disabled: true });
    if (liveConfig) {
      // The fixed expression returns data already read by our child preload.
      // Headers, URLs and credentials never get serialized to runtime files.
      patch.push({ id: 'config-editor', disabled: true });
      for (const id of configuration.namespaces) patch.push({ id, config: {
        __jsExpr: `globalThis[Symbol.for("cli-team.dsh.models")][${JSON.stringify(id)}]`,
      } });
    } else {
      patch.push({ insert: [{ id: 'cli-team-model-settings', name: new URL('./dsh-settings-bridge.mjs', import.meta.url).href,
        config: { sources: configuration.sources } }] });
    }
  } else if (!liveConfig) {
    patch.push({ id: 'settings', config: { path: path.join(source, 'settings.yaml'), watch: false } });
  }
  if (recovery) {
    patch.push({ id: 'acp', disabled: true });
    patch.push({ insert: [{ id: 'cli-team-acp-resume', name: new URL('./dsh-acp-resume-bridge.mjs', import.meta.url).href,
      config: configuration.bootstrapRoute || {} }] });
  } else if (configuration.bootstrapRoute) patch.push({ id: 'acp', config: configuration.bootstrapRoute });
  if (options.analysisOnly) {
    for (const id of ['tool-web', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
      'tool-skill', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents',
      'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'plan-mode']) patch.push({ id, disabled: true });
  }
  const text = JSON.stringify(patch, null, 2);
  if (!fs.existsSync(patchFile) || fs.readFileSync(patchFile, 'utf8') !== text) fs.writeFileSync(patchFile, text);
  return {
    home, patchFile, configuration, recovery,
    nodeArgs: liveConfig && configuration.sources.length ? ['--import', new URL('./dsh-model-preload.mjs', import.meta.url).href] : [],
    env: { ...childEnvironment(options.proxy), DSH_HOME: home,
      ...(dshDesktopInfo(member) ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(liveConfig && configuration.sources.length ? { CLI_TEAM_DSH_MODEL_SOURCES: JSON.stringify(configuration.sources) } : {}),
      ...(recovery ? { CLI_TEAM_DSH_RESUME_MODEL: JSON.stringify(recovery) } : {}),
      CLI_TEAM_DSH_SETTINGS_ANCHOR: (member.prefixArgs || []).find((arg) => path.isAbsolute(arg) && /[.][cm]?js$/i.test(arg))
        || path.join(source, 'profiles', 'package.json'),
      DSH_PERMISSION_MODE: member.permission === 'edit' ? 'workspace-write' : 'read-only',
      DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1' },
  };
}

function flattenOptions(options = []) {
  return options.flatMap((option) => option.options ? flattenOptions(option.options) : [option]);
}

export function dshModelOptions(configOptions = []) {
  return flattenOptions(configOptions.find((option) => option.id === 'model')?.options).map((option) => {
    let id = option.value;
    try {
      const route = JSON.parse(id);
      const [provider, model] = Array.isArray(route) ? route : [route.provider, route.model];
      if (typeof provider === 'string' && typeof model === 'string') id = `${provider}/${model}`;
    } catch { /* Some ACP implementations already use provider/model values. */ }
    return { id: diagnosticText(id, 300), name: diagnosticText(option.name || id, 300), value: option.value };
  }).slice(0, 300);
}

export function selectDshModel(configOptions, requested) {
  const field = configOptions?.find((option) => option.id === 'model');
  const options = flattenOptions(field?.options);
  const exact = options.filter((option) => option.value === requested || option.name === requested);
  const matches = exact.length ? exact : options.filter((option) => {
    try {
      const route = JSON.parse(option.value);
      const [provider, model] = Array.isArray(route) ? route : [route.provider, route.model];
      return model === requested || `${provider}/${model}` === requested;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error(`DSH 模型未唯一匹配：${requested}`);
  return { configId: field.id, value: matches[0].value };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeDsh(member, prompt, options) {
  const diagnostics = { transport: 'acp', stage: 'entry', method: null, requestedModel: member.model || null,
    selectedModel: null, promptSubmitted: false,
    session: { operation: options.conversationId ? 'resume' : 'new', requestedId: options.conversationId || null, id: null, state: 'pending' } };
  let invocation, runtime;
  try {
    invocation = buildInvocation(member, '', options);
    diagnostics.stage = 'configuration';
    runtime = prepareDshRuntime(options, member);
    diagnostics.configurationSources = runtime.configuration.sources.map((source) => source.path);
    diagnostics.defaultModel = runtime.configuration.defaultModel;
  } catch (cause) {
    const detail = protocolError(cause);
    return { success: false, response: '', report: null, conversationId: null, exitCode: null,
      riskFlags: ['connection_failed'], error: detail.text,
      diagnostics: { ...diagnostics, ...detail, hint: runtimeHint(detail.text, diagnostics.stage) } };
  }
  fs.mkdirSync(path.dirname(options.streamLog), { recursive: true });
  const flags = new Set();
  const warnings = [];
  let response = '';
  let usage = null;
  let sessionId = null;
  let stopReason = null;
  let error = null;
  let stderr = '';
  let totalBytes = 0;
  let timedOut = false;
  let consecutiveToolFailures = 0;
  const child = spawn(invocation.executable, [...runtime.nodeArgs, ...invocation.args, '--patch', runtime.patchFile], {
    cwd: options.workspace, env: runtime.env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  diagnostics.processStarted = false;
  child.once('spawn', () => { diagnostics.processStarted = true; });
  const log = fs.createWriteStream(options.streamLog, { encoding: 'utf8' });
  let closed = false;
  const exited = new Promise((resolve) => {
    child.once('close', (code) => { closed = true; resolve(code); });
  });
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  child.on('error', rejectFailure);
  child.stdin.on('error', (cause) => { if (cause.code !== 'EPIPE') rejectFailure(cause); });
  log.on('error', (cause) => rejectFailure(cause));
  const writeLog = (event) => log.write(`${redact(JSON.stringify(event))}\n`);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > 8 * 1024 * 1024) rejectFailure(new Error('DSH 输出超过 8 MiB'));
  });
  const boundedOutput = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > 8 * 1024 * 1024) {
        rejectFailure(new Error('DSH 输出超过 8 MiB'));
        callback();
      } else callback(null, chunk);
    },
  });
  child.stdout.pipe(boundedOutput);
  const app = client({ name: 'cli-team' })
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (sessionId && params.sessionId !== sessionId) return Promise.resolve();
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        response += update.content.text;
        if (response.length > 64000) rejectFailure(new Error('DSH 最终答复超过上限'));
      }
      if (update.sessionUpdate === 'usage_update') usage = update;
      const toolError = update.sessionUpdate === 'tool_call_update' && update.status === 'failed'
        ? (update.content || []).filter((item) => item.type === 'content' && item.content?.type === 'text')
          .map((item) => item.content.text).join('\n') : '';
      if (update.sessionUpdate === 'tool_call_update') {
        if (update.status === 'failed') {
          const denied = /permission.?denied|denied permission|permission check failed|not approved|requires? approval|approval required|denied by|\bEACCES\b|outside.*(?:workspace|allowed|scope)/i.test(toolError);
          const unavailable = /unknown tool|unrecognized tool|tool.*(?:not registered|not found|not available|does not exist)/i.test(toolError);
          const noChange = member.permission === 'edit' && !options.analysisOnly &&
            /^(?:Error:\s*)?old_string and new_string must differ\s*$/i.test(toolError);
          const unread = /^Error: cannot modify "([^"\r\n]+)": file has not been read \u2014 read the file, then retry$/.exec(toolError);
          let readFirst = false;
          if (unread && member.permission === 'edit' && !options.analysisOnly) {
            try { resolveInside(options.workspace, unread[1]); readFirst = true; }
            catch { /* A rejected out-of-scope edit is never a recoverable workspace warning. */ }
          }
          if (denied) flags.add('permission_denied');
          else if ((options.analysisOnly && unavailable) || noChange || readFirst) {
            if (warnings.length < 20) warnings.push(redact(`工具未执行：${toolError}`).slice(0, 500));
          } else flags.add('tool_failed');
          // Warnings still count toward the loop limit; disabled tools must not spin forever.
          if (++consecutiveToolFailures >= 3) {
            flags.add('repeated_tool_failure');
            rejectFailure(new Error('DSH 连续三次工具失败，已停止本轮，等待修正原因'));
          }
        } else if (update.status === 'completed') {
          consecutiveToolFailures = 0;
          if (options.analysisOnly) flags.add('analysis_tool_used');
        }
      }
      writeLog({ type: update.sessionUpdate, sessionId: params.sessionId,
        status: update.status, title: update.title, error: toolError ? redact(toolError).slice(0, 1200) : undefined,
        content: update.sessionUpdate === 'agent_message_chunk' ? update.content : undefined });
      return Promise.resolve();
    })
    .onRequest(methods.client.session.requestPermission, () => {
      flags.add('permission_denied');
      writeLog({ type: 'permission_denied' });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    });
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(boundedOutput)));
  const agent = connection.agent;
  const cancel = () => {
    if (sessionId) void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
    rejectFailure(new Error(options.signal?.aborted ? 'DSH 执行已取消' : 'DSH 执行超时'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMinutes * 60000);
  const request = (stage, method, params) => {
    diagnostics.stage = stage;
    diagnostics.method = typeof method === 'string' ? method : method.method || method.name;
    writeLog({ type: 'runtime_stage', stage, method: diagnostics.method });
    options.onRuntime?.({ ...diagnostics });
    return Promise.race([
      agent.request(method, params), failure,
      exited.then((code) => { throw new Error(`DSH 进程提前退出 (${code})：${diagnosticText(stderr)}`); }),
    ]);
  };
  let capabilities;
  let agentCapabilities;
  try {
    if (options.signal?.aborted) throw new Error('DSH 执行已取消');
    const initialized = await request('initialize', methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('DSH ACP 协议版本不兼容');
    agentCapabilities = initialized.agentCapabilities;
    diagnostics.protocolVersion = initialized.protocolVersion;
    diagnostics.capabilities = { resume: Boolean(agentCapabilities?.sessionCapabilities?.resume),
      close: Boolean(agentCapabilities?.sessionCapabilities?.close), modelSelection: false };
    if (options.conversationId && !diagnostics.capabilities.resume) throw new Error('此版本 DSH 未声明会话恢复能力，原会话保持不变');
    const session = options.conversationId
      ? await request('resume', methods.agent.session.resume, { sessionId: options.conversationId, cwd: options.workspace, mcpServers: [] })
      : await request('session', methods.agent.session.new, { cwd: options.workspace, mcpServers: [] });
    sessionId = session.sessionId || options.conversationId;
    if (!sessionId) throw new Error('DSH 未返回会话 ID');
    if (options.conversationId && sessionId !== options.conversationId) {
      sessionId = null;
      throw new Error('DSH 恢复返回了不同的会话 ID，已停止；原会话映射保持不变');
    }
    capabilities = session.configOptions || [];
    diagnostics.session = { ...diagnostics.session, id: sessionId, state: options.conversationId ? 'resumed' : 'created' };
    diagnostics.capabilities.modelSelection = capabilities.some((field) => field.id === 'model');
    diagnostics.models = dshModelOptions(capabilities).map(({ id, name }) => ({ id, name }));
    const currentModel = capabilities.find((field) => field.id === 'model')?.currentValue;
    diagnostics.selectedModel = dshModelOptions(capabilities).find((model) => model.value === currentModel)?.id || null;
    writeLog({ type: 'session_ready', sessionId, resumed: Boolean(options.conversationId),
      modelSelectionAvailable: capabilities.some((field) => field.id === 'model') });
    let modelRecovery = null;
    if (runtime.recovery && fs.existsSync(runtime.recovery.receiptFile)) {
      const stat = fs.lstatSync(runtime.recovery.receiptFile);
      if (!stat.isFile() || stat.size > 4096) throw new Error('DSH 模型恢复记录无效，已停止发送');
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(runtime.recovery.receiptFile, 'utf8')); }
      catch { throw new Error('DSH 模型恢复记录无法读取，已停止发送'); }
      modelRecovery = validateDshModelRecovery(receipt, runtime.recovery);
      const desired = member.model?.trim() || runtime.configuration.defaultModel;
      if (!desired || selectDshModel(capabilities, desired).value !== selectDshModel(capabilities, modelRecovery.to).value) {
        throw new Error('DSH 恢复模型与当前设置不一致，已停止发送；原会话保持不变');
      }
      diagnostics.modelRecovery = { from: modelRecovery.from, to: modelRecovery.to, reason: modelRecovery.reason, state: 'pending' };
    }
    if (member.model || modelRecovery) {
      diagnostics.stage = 'model';
      const selection = selectDshModel(capabilities, modelRecovery?.to || member.model);
      const selected = await request('model', methods.agent.session.setConfigOption, { sessionId, ...selection });
      if (modelRecovery) {
        if (selected.configOptions?.find(field => field.id === 'model')?.currentValue !== selection.value) {
          throw new Error('DSH 未确认恢复后的模型，已停止发送；原会话保持不变');
        }
        const effort = modelRecovery.selection.reasoningEffort;
        const reasoning = selected.configOptions.find(field => field.id === 'reasoning_effort');
        if (effort !== undefined && reasoning?.currentValue !== effort) {
          if (!flattenOptions(reasoning?.options).some(option => option.value === effort)) {
            throw new Error('DSH 恢复后的模型未提供当前推理设置，已停止发送');
          }
          const applied = await request('model', methods.agent.session.setConfigOption, { sessionId, configId: reasoning.id, value: effort });
          if (applied.configOptions?.find(field => field.id === reasoning.id)?.currentValue !== effort ||
              applied.configOptions?.find(field => field.id === 'model')?.currentValue !== selection.value) {
            throw new Error('DSH 未确认恢复后的推理设置，已停止发送');
          }
        }
        diagnostics.modelRecovery.state = 'applied';
        warnings.push(`原会话模型 ${modelRecovery.from} 已不可用，本轮改用 ${modelRecovery.to}；原会话和历史上下文已保留。`);
      }
      diagnostics.selectedModel = dshModelOptions(capabilities).find((model) => model.value === selection.value)?.id || member.model;
    }
    if (prompt !== null) {
      diagnostics.promptSubmitted = true;
      const result = await request('prompt', methods.agent.session.prompt, {
        sessionId, prompt: [{ type: 'text', text: prompt }],
      });
      stopReason = result.stopReason;
      if (stopReason !== 'end_turn') flags.add(`dsh_${stopReason || 'missing_stop_reason'}`);
    }
    diagnostics.stage = 'complete';
    diagnostics.method = null;
  } catch (cause) {
    const detail = protocolError(cause);
    error = detail.text;
    Object.assign(diagnostics, detail, { hint: runtimeHint(error, diagnostics.stage) });
    if (!sessionId) diagnostics.session.state = 'failed';
    flags.add(options.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'provider_error');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
    if (sessionId && !closed && agentCapabilities?.sessionCapabilities?.close) {
      await Promise.race([
        agent.request(methods.agent.session.close, { sessionId }).catch(() => {}),
        sleep(1500),
      ]);
    }
    child.stdin.end();
    if (!closed) await Promise.race([exited, sleep(2000)]);
    if (!closed) { killChild(child); await exited; }
    writeLog({ type: 'result', sessionId, stopReason, error, riskFlags: [...flags], warnings, diagnostics });
    await new Promise((resolve) => log.end(resolve));
    if (runtime.recovery) {
      try { fs.unlinkSync(runtime.recovery.receiptFile); } catch (cause) { if (cause.code !== 'ENOENT') warnings.push('模型恢复临时记录未能清理'); }
    }
  }
  const report = prompt === null ? null : parseReport(response);
  if (diagnostics.promptSubmitted && !report) flags.add('unstructured_report');
  return {
    success: !error && flags.size === 0 && child.exitCode === 0 && (prompt === null || stopReason === 'end_turn'),
    response: redact(response), report, conversationId: sessionId, usage, capabilities,
    riskFlags: [...flags], warnings, error, exitCode: child.exitCode, diagnostics,
    cancelled: Boolean(options.signal?.aborted), timedOut,
  };
}
