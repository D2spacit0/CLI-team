import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshResumeModelBridge, validateDshModelRecovery } from '../server/dsh-resume-model.mjs';

const old = { provider: 'local', model: 'old' };
const current = { provider: 'local', model: 'current' };
const alternate = { provider: 'other', model: 'chosen' };
const options = { sessionId: 'same-native-session', requestedModel: null, defaultSelection: current };
function fixture({ routes = [current, alternate], errorCode = 'UNKNOWN_MODEL', reasoningEffort } = {}) {
  const records = [], queries = [], dispatches = [];
  const llm = {
    async resolveCallConfig(selection) {
      queries.push(selection);
      if (!routes.some(route => route.provider === selection.provider && route.model === selection.model)) {
        throw Object.assign(new Error(`Cannot resolve ${selection.provider}/${selection.model}`), { code: errorCode });
      }
      return { ...selection, ...(reasoningEffort ? { reasoningEffort } : {}), maxTokens: 2048 };
    },
    listProviders() { return [...new Set(routes.map(route => route.provider))].map(id => ({ id })); },
    async listModels(provider) { return routes.filter(route => route.provider === provider).map(route => ({ id: route.model, name: route.name || route.model })); },
    async prepareCall(selection) { dispatches.push(selection); return this.resolveCallConfig(selection); },
  };
  return { llm, records, queries, dispatches, bridge(config = options) {
    return createDshResumeModelBridge(llm, config, receipt => records.push(receipt));
  } };
}

test('stale DSH model discovery exposes a validated current route without aliasing actual dispatch', async () => {
  const f = fixture();
  const bridge = f.bridge();
  assert.equal((await bridge.resolveCallConfig(old)).model, 'current');
  assert.equal((await bridge.resolveCallConfig(old)).model, 'current');
  assert.equal(f.records.length, 1, 'repeated option queries produce one recovery');
  assert.deepEqual(f.records[0], { version: 1, sessionId: options.sessionId, requestedModel: null,
    reason: 'UNKNOWN_MODEL', from: 'local/old', to: 'local/current', selection: current });
  await assert.rejects(bridge.prepareCall(old), { code: 'UNKNOWN_MODEL' }, 'real dispatch never maps old ids to a different model');
  assert.equal((await bridge.prepareCall(current)).model, 'current');
  assert.deepEqual(f.dispatches, [old, current]);
});

test('a usable native model is left intact, including its saved reasoning selection', async () => {
  const f = fixture({ routes: [old, current] });
  const selection = { ...old, reasoningEffort: 'medium' };
  assert.deepEqual(await f.bridge().resolveCallConfig(selection), { ...selection, maxTokens: 2048 });
  assert.equal(f.records.length, 0);
  assert.deepEqual(f.queries, [selection]);
});

test('explicit member models take precedence and removed providers can recover to that exact route', async () => {
  for (const requestedModel of ['other/chosen', 'chosen', 'Chosen model']) {
    const f = fixture({ routes: [current, { ...alternate, name: 'Chosen model' }], errorCode: 'NO_ADAPTER' });
    assert.equal((await f.bridge({ ...options, requestedModel }).resolveCallConfig(old)).provider, 'other');
    assert.equal(f.records[0].to, 'other/chosen');
    assert.equal(f.records[0].reason, 'NO_ADAPTER');
  }
});

test('missing or ambiguous current models and absent defaults never become a different fallback', async () => {
  for (const config of [{ ...options, requestedModel: 'other/missing' }, { ...options, requestedModel: 'missing' },
    { ...options, defaultSelection: null }, { ...options, defaultSelection: old }]) {
    const f = fixture();
    await assert.rejects(f.bridge(config).resolveCallConfig(old));
    assert.equal(f.records.length, 0);
  }
  const f = fixture({ routes: [{ ...current, name: 'same' }, { ...alternate, name: 'same' }] });
  await assert.rejects(f.bridge({ ...options, requestedModel: 'same' }).resolveCallConfig(old), /未唯一匹配/);
  assert.equal(f.records.length, 0);
});

test('authentication, cancellation, network and unsupported reasoning errors do not trigger recovery', async () => {
  for (const errorCode of ['AUTHENTICATION', 'ECONNREFUSED', 'UNSUPPORTED_REASONING_EFFORT', 'ABORT_ERR', 'UNKNOWN']) {
    const f = fixture({ errorCode });
    await assert.rejects(f.bridge().resolveCallConfig(old), { code: errorCode });
    assert.deepEqual(f.queries, [old]);
    assert.equal(f.records.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.bridge().resolveCallConfig(old, AbortSignal.abort()));
  assert.deepEqual(f.queries, [old]);
  assert.equal(f.records.length, 0);
});

test('replacement uses its own adapter defaults without carrying the old model reasoning effort', async () => {
  const f = fixture({ reasoningEffort: 'off' });
  await f.bridge().resolveCallConfig({ ...old, reasoningEffort: 'high' });
  assert.deepEqual(f.queries[1], current);
  assert.deepEqual(f.records[0].selection, { ...current, reasoningEffort: 'off' });
  assert.ok(!JSON.stringify(f.records).includes('maxTokens'));
});

test('receipt failures and unexpected second missing routes abort instead of hiding recovery', async () => {
  const f = fixture();
  const broken = createDshResumeModelBridge(f.llm, options, () => { throw new Error('receipt unavailable'); });
  await assert.rejects(broken.resolveCallConfig(old), /receipt unavailable/);
  const bridge = f.bridge();
  await bridge.resolveCallConfig(old);
  await assert.rejects(bridge.resolveCallConfig({ provider: 'unexpected', model: 'missing' }), { code: 'UNKNOWN_MODEL' });
  assert.equal(f.records.length, 1);
});

test('recovery evidence is scoped to one native session and only fixed metadata reaches diagnostics', async () => {
  const f = fixture();
  await f.bridge().resolveCallConfig(old);
  const record = f.records[0];
  assert.deepEqual(validateDshModelRecovery({ ...record, credentials: 'sentinel-private' }, options), {
    from: 'local/old', to: 'local/current', reason: 'UNKNOWN_MODEL', selection: current,
  });
  for (const change of [{ sessionId: 'other-session' }, { requestedModel: 'other/chosen' }, { version: 2 },
    { reason: 'AUTHENTICATION' }, { to: 'other/chosen' }, { from: 'local/current' },
    { selection: { ...current, reasoningEffort: { secret: 'private' } } }]) {
    assert.throws(() => validateDshModelRecovery({ ...record, ...change }, options), /恢复记录无法确认/);
  }
});
