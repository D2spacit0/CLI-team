import { createHash } from 'node:crypto';

// Application-owned instructions. User materials and agent output cannot replace
// this registry or grant capabilities. Changes produce a new input digest.
const sourceUrl = 'https://github.com/dabingfy-dot/solo-to-team-skills/tree/bc9c19458e9d4afe42e506fc65673a68c26c6a56';
const definitions = [
  { id: 'dispatch-receive-verify', name: '派工、收件与验收', version: '1.0.0', roles: ['all'], sourceUrl,
    description: '明确执行、接收和检查责任；保留原承诺；已收件与已验收分开。',
    instructions: '工作开始时读取责任人、收件人、原交时和完成条件。交付应指向实际文件或完整分析。成员自述完成不代表收到成果，收到也不代表验收。核验通过后才交下一棒。退回、失败和逾期仍未完成，由负责人接住并明确下一步；新预计不能覆盖原承诺。' },
  { id: 'evidence-before-done', name: '按证据确认交付', version: '1.0.0', roles: ['all'], sourceUrl,
    description: '区分执行报告、机器检查与独立判断，核对当前版本的真实成果。',
    instructions: '每项结论对应本次固定输入、范围与版本。打开实际交付，逐项核对完成条件；图片要看实际成品，文件检查成功不证明内容准确。没有核到的项目明确未核实，不伪造来源、测试或运行结果。修改后只复核有依据的受影响部分，旧证据只有版本与依赖仍有效时可复用。验收只涉及本工作，不代替人类发文批准。' },
  { id: 'owner-follow-through', name: '负责人处理未完工作', version: '1.0.0', roles: ['plan', 'coordinate'], sourceUrl,
    description: '安排有明确责任的工作，处理退回和阻碍，确保下一棒实际开工。',
    instructions: '在项目授权、每日预算和尝试上限内派工。把用户要求落实到工作项和验收条件。遇到失败需要选择重试、说明原因改期或明确取消；不要把失败当业务完成，不无限重复调用。阶段验收通过后确认下游已派发或说明具体阻碍。向用户概括结果、成果位置和下一步，诊断细节放在证据记录。' },
];

export const skillCatalog = definitions.map(({ instructions, ...entry }) => ({ ...entry,
  digest: createHash('sha256').update(JSON.stringify({ ...entry, instructions })).digest('hex') }));

export function skillsForWork(kind) {
  return definitions.filter(skill => skill.roles.includes('all') || skill.roles.includes(kind)).map(skill => ({
    ...skill, digest: skillCatalog.find(entry => entry.id === skill.id).digest,
  }));
}
