import test from 'node:test';
import assert from 'node:assert/strict';
import { agentReport, delegationSchema, OutputCollector, parseReport, reportSchema } from '../server/adapters.mjs';

const report = { summary: '按技能安排实现与检查', status: 'complete' };
const step = { key: 'implement', title: '实现接口', objective: '实现任务接口并验证输入', memberId: 'backend-agent' };

test('legacy reports remain accepted and default to no delegation', () => {
  assert.equal(parseReport(JSON.stringify(report)).delegation, null);
  assert.equal(agentReport.parse({ ...report, delegation: null }).delegation, null);
  assert.equal(reportSchema.required.includes('delegation'), false);
});

test('delegation survives direct, fenced and provider terminal report parsing', () => {
  const planned = { ...report, delegation: { steps: [
    { ...step, title: ' 实现接口 ', memberId: ' backend-agent ' },
    { ...step, key: 'verify', memberId: 'review-agent', dependsOn: ['implement'] },
  ] } };
  const json = JSON.stringify(planned);
  const direct = parseReport(json);
  assert.equal(direct.delegation.steps[0].title, '实现接口');
  assert.equal(direct.delegation.steps[0].memberId, 'backend-agent');
  assert.deepEqual(direct.delegation.steps[0].dependsOn, []);
  assert.deepEqual(direct.delegation.steps[1].dependsOn, ['implement']);
  assert.deepEqual(parseReport(`计划如下：\n\`\`\`json\n${json}\n\`\`\``), direct);
  const collector = new OutputCollector('antigravity', process.cwd());
  collector.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: json } }));
  const result = collector.finish(0);
  assert.equal(result.success, true);
  assert.deepEqual(result.report, direct);
});

test('malformed or oversized plans fail closed through the actual report parser', () => {
  const invalidPlans = [
    { steps: [] },
    { steps: Array.from({ length: 7 }, () => step) },
    { steps: [step], command: 'unexpected' },
    ...[
      { key: 'UPPER' }, { key: 'a'.repeat(41) }, { key: '../escape' },
      { title: ' ' }, { title: 'a'.repeat(121) },
      { objective: '' }, { objective: 'a'.repeat(3001) },
      { memberId: '\n' }, { memberId: 'a'.repeat(201) },
      { dependsOn: [123] }, { dependsOn: Array(7).fill('other') },
      { command: 'unexpected' },
    ].map((override) => ({ steps: [{ ...step, ...override }] })),
  ];
  for (const delegation of invalidPlans) {
    assert.equal(delegationSchema.safeParse(delegation).success, false);
    assert.equal(parseReport(JSON.stringify({ ...report, delegation })), null);
  }
  const valid = JSON.stringify(report);
  const invalid = JSON.stringify({ ...report, delegation: { steps: [] } });
  assert.equal(parseReport(`${valid}\n${invalid}`), null, 'a final invalid plan must not fall back to an earlier report');
});
