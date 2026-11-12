import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { renderContentCard } from './content-renderer.mjs';

const root = process.env.CLI_TEAM_RENDER_SMOKE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('真实图文渲染检查需要独立测试目录。');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'electron-profile'));
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
try {
  const cover = await renderContentCard({ template: 'cover', title: '把一天的工作\n安排得更从容',
    subtitle: '三个可以立即尝试的小方法\n从明确下一步开始，把注意力留给真正要完成的事。',
    eyebrow: '工作方法 · 实践笔记', footer: '先做一件小事，再调整下一步', accent: 'blue' });
  fs.writeFileSync(path.join(root, 'cover.png'), cover.buffer);
  const card = await renderContentCard({ template: 'list', title: '让计划可以开始执行', eyebrow: '工作方法 · 操作清单',
    items: ['先写下今天必须完成的一件事，把目标说具体。', '把第一步缩小到十五分钟内可以开始的动作。', '预留一段空白时间，接住临时任务和意外。', '结束前记录进展，再安排明天的第一步。'],
    footer: '方法要在真实工作中检验与调整', accent: 'green' });
  fs.writeFileSync(path.join(root, 'list.png'), card.buffer);
  let overflowRejected = false;
  try { await renderContentCard({ template: 'list', title: '容量检查', items: Array(6).fill('这是用于检查文字超出画布之后会明确拒绝制作的长内容。'.repeat(3)) }); }
  catch (error) { overflowRejected = /超过画布|缩短/.test(error.message); }
  if (!overflowRejected) throw new Error('文字溢出未被明确拒绝。');
  fs.writeFileSync(path.join(root, 'render-smoke.json'), JSON.stringify({ ok: true, electron: process.versions.electron,
    cover: { width: cover.width, height: cover.height, bytes: cover.buffer.length, templateVersion: cover.templateVersion, renderCheck: cover.renderCheck },
    list: { width: card.width, height: card.height, bytes: card.buffer.length, templateVersion: card.templateVersion, renderCheck: card.renderCheck },
    overflowRejected, credentialAccess: false }, null, 2));
  app.exit(0);
} catch (error) {
  fs.writeFileSync(path.join(root, 'render-smoke.json'), JSON.stringify({ ok: false, error: error.message }));
  console.error(error.message);
  app.exit(1);
}
});
