import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { dshHome } from './dsh-sessions.mjs';

const namespaces = new Set(['agent-default-model', 'llm-pi-ai', 'llm-deepseek']);
const isFile = (filename) => { try { return fs.statSync(filename).isFile(); } catch { return false; } };

function readDocument(filename) {
  if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error('DSH 模型配置文件超过 2 MiB');
  const document = YAML.parseDocument(fs.readFileSync(filename, 'utf8'), { prettyErrors: false, logLevel: 'silent' });
  // Parser messages can contain configuration values, including credentials.
  if (document.errors.length || document.warnings.length) throw new Error(`DSH 模型配置无法解析：${filename}，请在官方客户端检查配置格式`);
  return document.toJS({ maxAliasCount: 50 });
}

export function readDshModelSettings(sources) {
  const settings = {};
  for (const source of sources) {
    const document = readDocument(source.path);
    if (source.kind === 'settings') {
      for (const key of namespaces) if (document?.[key] && typeof document[key] === 'object') settings[key] = document[key];
    } else {
      if (!Array.isArray(document)) throw new Error(`DSH profile 配置应为列表：${source.path}`);
      const visit = (rows) => {
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          if (namespaces.has(row.id) && row.config && !Array.isArray(row.config)) {
            if (row.disabled) delete settings[row.id];
            else settings[row.id] = row.config;
          }
          if (Array.isArray(row.insert)) visit(row.insert);
          if (row.group && Array.isArray(row.config)) visit(row.config);
        }
      };
      visit(document);
    }
  }
  return settings;
}

export function dshConfigSources(member, sourceHome = dshHome()) {
  const profile = member.dshConfigProfile || 'auto';
  if (!['auto', 'acp', 'desktop', 'web'].includes(profile)) throw new Error('DSH 配置来源无效');
  const candidates = (profile === 'auto' ? ['acp', 'desktop', 'web'] : [profile])
    .map((name) => ({ kind: 'patch', profile: name, path: path.join(sourceHome, 'profiles', name, 'cordis.patch.yml') }));
  const selected = candidates.find((source) => isFile(source.path) && (profile !== 'auto' || Object.keys(readDshModelSettings([source])).length));
  if (profile !== 'auto' && !selected) throw new Error(`未找到 DSH ${profile} 配置，请检查官方客户端的 profile`);
  const sources = selected ? [selected] : [];
  const shared = path.join(sourceHome, 'cordis.patch.yml');
  if (isFile(shared)) sources.push({ kind: 'patch', profile: 'shared', path: shared });
  const legacy = path.join(sourceHome, 'settings.yaml');
  if (isFile(legacy)) sources.push({ kind: 'settings', path: legacy });
  return sources;
}

export function describeDshConfiguration(member, sourceHome = dshHome()) {
  const sources = dshConfigSources(member, sourceHome);
  const settings = readDshModelSettings(sources);
  const defaultModel = settings['agent-default-model'];
  const route = typeof defaultModel?.provider === 'string' && typeof defaultModel?.model === 'string'
    ? { provider: defaultModel.provider, model: defaultModel.model } : null;
  const models = [];
  for (const [provider, config] of Object.entries(settings['llm-pi-ai']?.providers || {})) {
    for (const model of Array.isArray(config?.models) ? config.models : []) {
      if (typeof model?.id === 'string') models.push({ provider, model: model.id, name: model.name || model.id });
    }
  }
  const requested = member.model?.trim();
  const matches = models.filter((item) => requested === item.model || requested === item.name || requested === `${item.provider}/${item.model}`);
  const split = requested?.indexOf('/') ?? -1;
  const requestedRoute = split > 0 && split < requested.length - 1
    ? { provider: requested.slice(0, split), model: requested.slice(split + 1) }
    : matches.length === 1 ? { provider: matches[0].provider, model: matches[0].model } : null;
  return { sources, namespaces: Object.keys(settings),
    defaultReasoningEffort: typeof defaultModel?.reasoningEffort === 'string' ? defaultModel.reasoningEffort : null,
    defaultModel: route ? `${route.provider}/${route.model}` : null, bootstrapRoute: route || requestedRoute };
}
