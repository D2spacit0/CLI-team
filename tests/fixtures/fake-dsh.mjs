import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
const mode = process.argv[2];
const recoveryMode = mode.startsWith('recovery-');
const recovery = recoveryMode ? JSON.parse(process.env.CLI_TEAM_DSH_RESUME_MODEL) : null;
const observed = [];
let modelApplied = false;
const modelOptions = (currentValue = '["local","qwen38"]') => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue,
  options: [{ name: 'qwen38', value: '["local","qwen38"]' }, { name: 'other', value: '["local","other"]' }] }];
const report = { summary: 'DSH ACP fixture', status: 'complete', verdict: 'none', findings: [], handoff: null };
let pending = null;
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const reply = (id, result) => send({ id, result });
const update = (value) => send({ method: 'session/update', params: { sessionId: 'fake-session', update: value } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const { id, method } = message;
  if (recoveryMode) {
    observed.push(method);
    fs.writeFileSync(path.join(process.cwd(), 'fixture-requests.json'), JSON.stringify(observed));
  }
  if (method === 'initialize') reply(id, { protocolVersion: mode === 'wrong-version' ? 999 : 1,
    agentCapabilities: { sessionCapabilities: { ...(mode === 'no-resume' ? {} : { resume: {} }), close: {} } } });
  if (method === 'session/new' || method === 'session/resume') {
    if (recoveryMode) {
      if (method !== 'session/resume') throw new Error('Recovery must never create a replacement session');
      const model = mode === 'recovery-wrong-target' ? 'other' : 'qwen38';
      fs.writeFileSync(recovery.receiptFile, JSON.stringify({ version: 1,
        sessionId: mode === 'recovery-wrong-session' ? 'unrelated-session' : recovery.sessionId,
        requestedModel: recovery.requestedModel, reason: 'UNKNOWN_MODEL', from: 'local/Qwen3.8-27B',
        to: `local/${model}`, selection: { provider: 'local', model } }));
      reply(id, { sessionId: message.params.sessionId, configOptions: modelOptions() });
    } else if (method === 'session/resume' && mode === 'missing-provider') {
      send({ id, error: { code: -32603, message: 'Internal error', data: {
        details: 'no adapter registered for provider "local"; api_key=secret-never-log',
        headers: { authorization: 'secret-header-never-log' },
      } } });
    } else if (method === 'session/resume' && mode === 'locked') {
      send({ id, error: { code: -32000, message: 'Session write lock is owned by Desktop' } });
    } else reply(id, { sessionId: 'fake-session', configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'local/test',
      options: [{ name: 'test-model', value: 'local/test' }],
    }] });
  }
  if (method === 'session/set_config_option') {
    if (recoveryMode) {
      modelApplied = mode !== 'recovery-unconfirmed' && message.params.value === '["local","qwen38"]';
      reply(id, { configOptions: modelOptions(modelApplied ? message.params.value : '["local","old"]') });
    } else if (mode === 'default-only') send({ id, error: { code: -32603, message: 'CLI default must not be overridden' } });
    else reply(id, { configOptions: [] });
  }
  if (method === 'session/prompt') {
    if (recoveryMode && !modelApplied) throw new Error('No prompt before the replacement model is applied');
    if (mode === 'probe-only') { send({ id, error: { code: -32603, message: 'A connection probe must not submit a task' } }); return; }
    if (mode === 'wait') { pending = id; return; }
    if (mode === 'loop' || mode === 'unavailable-loop') {
      for (let i = 0; i < 3; i++) update({ sessionUpdate: 'tool_call_update', toolCallId: `failed-${i}`, status: 'failed',
        ...(mode === 'unavailable-loop' ? { content: [{ type: 'content', content: {
          type: 'text', text: 'Unknown tool: todo_write',
        } }] } : {}) });
      pending = id;
      return;
    }
    if (mode === 'denied') {
      send({ id: 'permission', method: 'session/request_permission', params: {
        sessionId: 'fake-session', toolCall: { toolCallId: 'tool-1', title: 'unapproved shell', kind: 'execute' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
      } });
      pending = id;
      return;
    }
    if (mode === 'unavailable' || mode === 'soft-denied' || mode === 'noop-edit') {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'failed-tool', status: 'failed',
        content: [{ type: 'content', content: { type: 'text',
          text: mode === 'unavailable' ? 'Unknown tool: todo_write' : mode === 'noop-edit'
            ? 'Error: old_string and new_string must differ' : 'permission check failed for read_file: user denied permission' } }] });
    }
    if (mode === 'read-first' || mode === 'outside-read-first') {
      const target = path.join(process.cwd(), mode === 'read-first' ? 'artifact.json' : '../outside.json');
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-guard', status: 'failed',
        content: [{ type: 'content', content: { type: 'text',
          text: `Error: cannot modify "${target}": file has not been read \u2014 read the file, then retry` } }] });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-file', status: 'completed' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-file', status: 'completed' });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } });
    reply(id, { stopReason: 'end_turn' });
  }
  if (id === 'permission' && message.result) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } });
    reply(pending, { stopReason: 'end_turn' });
    pending = null;
  }
  if (method === 'session/cancel' && pending !== null) {
    reply(pending, { stopReason: 'cancelled' });
    pending = null;
  }
  if (method === 'session/close') reply(id, {});
});
