// ACP 0.2 validates a persisted route before accepting set_config_option. This
// facade is used only by our ACP child to expose the configured replacement in
// that initial option query. The runner MUST apply it through standard ACP and
// verify the returned selection before submitting a prompt. Dispatch, session
// persistence and locks remain owned by the official DSH services.
const missingRoute = new Set(['UNKNOWN_MODEL', 'NO_ADAPTER']);
const label = ({ provider, model }) => `${provider}/${model}`;
const sameRoute = (left, right) => left.provider === right.provider && left.model === right.model;

async function desiredSelection(llm, requested, fallback) {
  if (!requested) return fallback;
  const split = requested.indexOf('/');
  if (split > 0 && split < requested.length - 1) {
    return { provider: requested.slice(0, split), model: requested.slice(split + 1) };
  }
  const catalogs = await Promise.all(llm.listProviders().map(async (provider) =>
    (await llm.listModels(provider.id)).map(model => ({ provider: provider.id, model: model.id, name: model.name }))));
  const models = catalogs.flat();
  const names = models.filter(model => model.name === requested);
  const matches = names.length ? names : models.filter(model => model.model === requested);
  if (matches.length !== 1) throw new Error(`DSH 模型未唯一匹配：${requested}`);
  return { provider: matches[0].provider, model: matches[0].model };
}

export function createDshResumeModelBridge(llm, options, record) {
  let recovered;
  const resolveCallConfig = async (selection, signal) => {
    try { return await llm.resolveCallConfig(selection, signal); }
    catch (error) {
      if (!missingRoute.has(error?.code) || signal?.aborted) throw error;
      if (recovered && !sameRoute(selection, recovered.from)) throw error;
      const desired = recovered?.to || await desiredSelection(llm, options.requestedModel, options.defaultSelection);
      if (!desired || sameRoute(selection, desired)) throw error;
      // Validate the actual current route, not an alias for the removed model.
      // Authorization, network and unsupported-reasoning failures propagate.
      const resolved = await llm.resolveCallConfig(desired, signal);
      signal?.throwIfAborted();
      const to = { provider: resolved.provider, model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) };
      if (!recovered) {
        const from = { provider: selection.provider, model: selection.model };
        // A failed receipt write aborts discovery; there is no unrecorded fallback.
        record({ version: 1, sessionId: options.sessionId, requestedModel: options.requestedModel || null,
          reason: error.code, from: label(from), to: label(to), selection: to });
        recovered = { from, to };
      }
      return resolved;
    }
  };
  return new Proxy(llm, { get(target, property) {
    if (property === 'resolveCallConfig') return resolveCallConfig;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function validateDshModelRecovery(value, options) {
  const routePart = part => typeof part === 'string' && part.length > 0 && part.length <= 300 && !/[\x00-\x1f\x7f]/.test(part);
  if (value?.version !== 1 || value.sessionId !== options.sessionId ||
      value.requestedModel !== (options.requestedModel || null) || !missingRoute.has(value.reason) ||
      !routePart(value.from) || !routePart(value.to) || value.from === value.to ||
      !routePart(value.selection?.provider) || !routePart(value.selection?.model) ||
      label(value.selection) !== value.to ||
      (value.selection.reasoningEffort !== undefined && !routePart(value.selection.reasoningEffort))) {
    throw new Error('DSH 模型恢复记录无法确认，已停止发送；原会话保持不变');
  }
  // Select only fixed fields: never forward arbitrary child/config payloads.
  return { reason: value.reason, from: value.from, to: value.to,
    selection: { provider: value.selection.provider, model: value.selection.model,
      ...(value.selection.reasoningEffort === undefined ? {} : { reasoningEffort: value.selection.reasoningEffort }) } };
}
