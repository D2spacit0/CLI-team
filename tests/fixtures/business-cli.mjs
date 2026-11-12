import fs from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'inputs', 'context.json'), 'utf8'));
const { assignment, project } = context;
if (!assignment?.id || !assignment.kind || !project?.id) throw new Error('缺少本次工作绑定的固定上下文');
const owner = project.ownerId;
const reviewer = project.reviewerId;
const visual = project.memberIds.find(memberId => memberId !== owner && memberId !== reviewer);
const correction = '这是一条经验建议，尚无实测对照数据。';
const report = { summary: `受控真实Node进程已完成 ${assignment.kind}，进程 ${process.pid}`, status: 'complete', verdict: 'none',
  findings: [], handoff: null, analysis: [], business: { version: 1, actions: [] } };
const analysis = { type: 'analysis', sections: ['summary'] };
if (assignment.kind === 'plan') {
  if (!owner || !reviewer || !visual) throw new Error('真实进程未读到项目团队身份');
  report.business.actions = [
    { key: 'copy', kind: 'copy', memberId: owner, dependsOn: [], output: analysis },
    { key: 'visual', kind: 'visual', memberId: visual, dependsOn: [], output: analysis },
    { key: 'integrate', kind: 'integrate', memberId: owner, dependsOn: ['copy', 'visual'], output: { type: 'files', files: [{ path: 'note.json', format: 'json' }] } },
    { key: 'review', kind: 'review', memberId: reviewer, dependsOn: ['integrate'], output: analysis },
  ].map(item => ({ ...item, type: 'propose_work', title: `实际进程${item.kind}`, objective: `完成本篇图文的${item.kind}工作`, inputRefs: [] }));
} else if (assignment.kind === 'integrate') {
  if (!prompt.includes('依赖结果')) throw new Error('整合工作缺少成员依赖结果');
  const revised = Boolean(assignment.feedback);
  fs.writeFileSync('note.json', JSON.stringify({ title: '安排好每天第一步', body: `先写下一件要完成的事，再把第一步缩小到十五分钟可以开始的动作。${revised ? correction : ''}`,
    tags: ['工作方法'], sources: [{ label: '受控流程验收稿件，仅用于本地测试' }],
    images: [{ template: 'cover', title: '从明确第一步开始', subtitle: '把计划变成可以执行的动作', accent: 'blue' }],
    requiresRealPhotos: false, changeSummary: revised ? '根据固定收件的审稿意见补充经验建议说明' : '整合文案与视觉成员的固定交付' }));
} else if (assignment.kind === 'accept') {
  const target = assignment.acceptanceFor;
  if (!target?.workItemId || !target.receiptId || !target.resultDigest || !target.generation) throw new Error('验收工作没有绑定固定收件');
  if (!target.summary?.trim()) throw new Error('不能仅凭完成状态验收空交付');
  report.verdict = 'approve';
  report.summary += `；已读取收件 ${target.receiptId} 并检查目标 ${target.workItemId} 第 ${target.generation} 代成果`;
} else if (assignment.kind === 'review') {
  const outcome = context.outcomes?.at(-1);
  if (!outcome?.id || !outcome.manifestHash || !outcome.body) throw new Error('审稿没有读取固定整稿版本');
  const changes = process.argv.includes('--request-changes-once') && !outcome.body.includes(correction);
  report.verdict = changes ? 'changes_requested' : 'approve';
  report.summary += changes ? '；请标注这是经验建议，未获得实测对照数据' : `；已核对固定稿件 ${outcome.id} 的经验建议与来源`;
}
else if (!['copy', 'visual'].includes(assignment.kind)) throw new Error(`Unknown fixture kind ${assignment.kind}`);
process.stdout.write(JSON.stringify(report) + '\n');
