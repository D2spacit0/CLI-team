// Runs inside the installed official client. Its installation, credentials and
// native session logs are never rewritten by this compatibility bridge.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDshResumeModelBridge } from './dsh-resume-model.mjs';

const requireDsh = createRequire(process.env.CLI_TEAM_DSH_SETTINGS_ANCHOR);
const official = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-acp')).href);
const recovery = JSON.parse(process.env.CLI_TEAM_DSH_RESUME_MODEL);
delete process.env.CLI_TEAM_DSH_RESUME_MODEL;

export const name = 'cli-team-acp-resume';
export const inject = official.inject;
export const Config = official.Config;
export function apply(ctx, config) {
  const llm = createDshResumeModelBridge(ctx.llm, recovery, receipt => {
    fs.writeFileSync(recovery.receiptFile, JSON.stringify(receipt), { flag: 'wx' });
  });
  // Context.extend is the official scoped-service overlay. Other plugins keep
  // the original LLM service, including its real model dispatch and tool policy.
  return official.apply(ctx.extend({ llm }), config);
}
