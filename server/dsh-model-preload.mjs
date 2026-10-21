// Executed only inside the official DSH child, before Cordis loads. Values
// remain in memory; the patch contains fixed expressions and source paths only.
import { readDshModelSettings } from './dsh-config.mjs';
const sources = JSON.parse(process.env.CLI_TEAM_DSH_MODEL_SOURCES || '[]');
delete process.env.CLI_TEAM_DSH_MODEL_SOURCES;
Object.defineProperty(globalThis, Symbol.for('cli-team.dsh.models'), {
  value: readDshModelSettings(sources), configurable: false, writable: false,
});
