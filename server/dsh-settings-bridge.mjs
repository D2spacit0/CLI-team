// Loaded only INSIDE the official DSH child. Configuration values never cross
// the ACP connection or get copied into CLI Team's database/runtime files.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readDshModelSettings } from './dsh-config.mjs';

const requireDsh = createRequire(process.env.CLI_TEAM_DSH_SETTINGS_ANCHOR);
const { SettingsProvider } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-settings')).href);

export default class OfficialModelSettings extends SettingsProvider {
  constructor(ctx, config) { super(ctx); this.sources = config.sources; }
  get writable() { return false; }
  async load() { return readDshModelSettings(this.sources); }
  async persist() { throw new Error('请在 DSH 官方客户端修改模型配置'); }
}
