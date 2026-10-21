# CLI Team：多 Agent 协作参考与改进顺序

调研日期：2026-10-08。依据为当前项目源码及 GitHub 官方 README、文档、关键实现。参考项目未安装运行；源码证实机制存在，不代表模型效果、Windows 稳定性或无人值守能力已经实测。本文是后续改进建议，尚未实现的新功能均明确作为建议描述。

## 结论

建议继续使用现有 Electron、Node.js、SQLite 桌面架构，优先补齐“成员求助 → 负责人作出决定 → 原步骤继续”“步骤交付检查”“保留有效成果的局部恢复”。这些机制比增加角色数量更直接地改善团队协作。

目前项目已有负责人规划、限定成员池、技能描述、依赖交接、串行派工、负责人汇总、机器验收、独立评审，以及暂停后改派并继续。下一轮工作应在这些基础上延伸。

## 当前代码中的具体缺口

| 顺序 | 当前行为 | 建议 | 预期改善 |
| --- | --- | --- | --- |
| 1 | 任务报告有 `needs_help`，但没有关联原步骤的提问、答复和恢复协议；普通聊天才处理 `handoff`。 | 建立持久化求助记录，由负责人答复或选定授权同伴协助，再恢复提问步骤。 | 成员遇到接口、材料、职责不明确的问题时，团队内部可以完成澄清。 |
| 2 | 步骤依赖根据执行记录的 `succeeded` 放行；步骤结构没有预期产物字段，总体验收在负责人汇总后执行。 | 每步定义交付物、格式、依赖输入及检查条目。分析任务可以交付结构化结论，写入任务绑定文件版本。 | 下一位成员拿到可检查的输入，减少“上游说完成，下游找不到结果”。 |
| 3 | 协作者失败会进入整轮重新规划，新计划的步骤全部初始化为待执行；已支持负责人规划或汇总阶段的原阶段重试。 | 补协作者原步骤重试和检查点；保留证据仍有效的成功步骤，只使受影响的后继失效。 | 减少重复劳动与重复消耗，保护已有成果。 |
| 4 | 技能作为自由文本进入提示词，负责人规划时固定 `memberId`。 | 保留描述，增加能力标签、适用任务、可用性及负载；显示推荐某成员的原因。 | 选人更容易核对，避免把“擅长”当成权限或已验证能力。 |
| 5 | 负责人制定计划后，步骤按固定依赖依次执行，全部完成后汇总。 | 在求助、失败、阶段交付等事件上唤醒负责人，允许更新尚未执行的计划。 | 负责人可以根据过程中的新发现持续协调。 |
| 6 | 当前及上一轮完整结果已经交接；其他历史仍依赖最近消息和运行窗口。 | 保存带来源的接口约定、决策、未解决问题及产物引用，按步骤提供相关内容。 | 关键决定不依赖聊天位置，交接更紧凑。 |

本地依据：[报告与步骤协议](../../server/adapters.mjs:7)、[服务调度与交接](../../server/service.mjs:820)、[跨步骤上下文](../../server/delegation-context.mjs:6)。主要入口为 `advanceDelegatedStep`、`dispatchDelegatedStep`、`planDelegation`、`acceptDelegationPlan` 和 `buildDelegationContext`。

## 值得借鉴的项目

### Pane：最贴近当前技术栈的桌面参考

[greenfield-inc/Pane](https://github.com/greenfield-inc/Pane) 使用 Electron、React、TypeScript 和 SQLite，其 [Windows 构建说明](https://github.com/greenfield-inc/Pane/blob/b08541d7de847b37bf62da4bedc35b022b446e05/docs/BUILDING_ON_WINDOWS.md) 覆盖 x64 与 ARM64。平台支持依据是文档和构建路径，本次未运行其 Windows 成品。

- [架构说明](https://github.com/greenfield-inc/Pane/blob/b08541d7de847b37bf62da4bedc35b022b446e05/docs/ARCHITECTURE.md) 将协调会话、工作区、成员面板和报告关联起来；Windows 的 PTY 放在独立进程中，输出有流控和有界保存。
- [CLI 报告协议](https://github.com/greenfield-inc/Pane/blob/b08541d7de847b37bf62da4bedc35b022b446e05/docs/RUNPANE_CLI_CONTRACT.md) 的 `runpane report` 保存状态、摘要、版本和待回答问题，产生持久 `agent.report` 事件，并呈现在会话概览中。
- [协作账本](https://github.com/greenfield-inc/Pane/blob/b08541d7de847b37bf62da4bedc35b022b446e05/main/src/services/paneChatBundle/skills/orchestrate-sessions/references/ledger.md) 记录角色、技能、工作项、会话、事件、来源版本及决策依据。

应用到本项目：在同一任务视图中展示负责人与协作者、待回答问题、交付回执及可打开的证据；将交接内容按“已完成且已验证、进行中、下一步、约束、未解决问题”组织。宿主记录事件、调度器检查证据、负责人作出判断，这三个责任保持明确。Pane README 标注 AGPL-3.0，本文仅提炼机制与交互。

### Routa：最接近当前协作目标

[phodal/routa](https://github.com/phodal/routa) 同时提供工作区、看板、CLI 适配器和 Tauri 桌面形态。最值得参考的是成员回报、事件唤醒、父子任务关联，以及任务进入下一阶段之前的内容要求。

- [`agent-tools.ts`](https://github.com/phodal/routa/blob/e48861ab81e2b30378fd32f05204a3ab424c4fec/src/core/tools/agent-tools.ts#L499) 有向父角色回报、给任务负责人发消息、订阅事件的操作。
- [`orchestrator.ts`](https://github.com/phodal/routa/blob/e48861ab81e2b30378fd32f05204a3ab424c4fec/src/core/orchestration/orchestrator.ts#L274) 监听成员回报与生命周期事件；完成处理有去重和结果记忆。
- [`task-contract-readiness.ts`](https://github.com/phodal/routa/blob/e48861ab81e2b30378fd32f05204a3ab424c4fec/src/core/kanban/task-contract-readiness.ts#L82) 检查任务描述的结构要求，并对重复失败设置停止条件。

应用到本项目：让成员求助和阶段结果形成可追踪事件，负责人据此继续协调。借鉴事件与阶段检查机制；本项目继续将成员自述、实际文件检查、整体验收分开。Routa 的 `reportToParent` 本身会依据报告中的 `success` 更新任务状态，这一行为不应成为本项目的验收依据。

### CrewAI：派工与问答都有明确回执

[crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) 是框架，适合参考负责人和协作者之间的请求协议。

- [派工工具](https://github.com/crewAIInc/crewAI/blob/1d4015439a7a7b13d473a7df06da7d5c69f3cd08/lib/crewai/src/crewai/tools/agent_tools/delegate_work_tool.py#L8) 将任务、上下文和接收成员放在明确字段中。
- [提问工具](https://github.com/crewAIInc/crewAI/blob/1d4015439a7a7b13d473a7df06da7d5c69f3cd08/lib/crewai/src/crewai/tools/agent_tools/ask_question_tool.py#L8) 让询问成为可执行调用，而不是寄希望于聊天里有人注意到。
- [执行及返回结果](https://github.com/crewAIInc/crewAI/blob/1d4015439a7a7b13d473a7df06da7d5c69f3cd08/lib/crewai/src/crewai/tools/agent_tools/base_agent_tools.py#L110) 将结果或错误返回调度者。

应用到本项目：在现有结构化报告中增加 `consult` 或 `request_context`，记录 `requestId`、`stepKey`、`memberId` 和答复来源。继续使用精确成员 ID；不用角色名称匹配替代身份核验。

### LangGraph：恢复到有证据的步骤

[langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) 的价值在持久状态、恢复和重试语义，可以把这些机制移植到现有 SQLite 调度器。

- [检查点结构](https://github.com/langchain-ai/langgraph/blob/40a2e6d845054cc0cc17a6a169ca6e7394e5231c/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L93) 保存版本和步骤状态。
- [interrupt 与恢复](https://github.com/langchain-ai/langgraph/blob/40a2e6d845054cc0cc17a6a169ca6e7394e5231c/libs/langgraph/langgraph/types.py#L893) 明确恢复会重新执行所在节点。
- [重试实现](https://github.com/langchain-ai/langgraph/blob/40a2e6d845054cc0cc17a6a169ca6e7394e5231c/libs/langgraph/langgraph/pregel/_retry.py#L641) 区分可重试异常、次数及等待策略。

应用到本项目：检查点绑定输入、配置、产物哈希和证据版本；步骤完成与后继入队应事务化，并设置防止重复派工的唯一键。调度恢复不能恢复已退出的 CLI 进程，也不能撤销已经写入的文件；重新执行前必须检查已有成果。

### Paperclip：任务责任、事件去重与预算

[paperclipai/paperclip](https://github.com/paperclipai/paperclip) 是 Node.js 服务与 React 管理界面，默认涉及 PostgreSQL。适合参考组织和任务机制，不需要照搬其部署方式。

- [任务工作流](https://github.com/paperclipai/paperclip/blob/5717523b9ea7a2d76efbd6eb73414de9c06c6f96/docs/guides/agent-developer/task-workflow.md) 描述原子认领、重复认领的幂等处理、父子任务及阻塞升级。
- [依赖解除后的唤醒](https://github.com/paperclipai/paperclip/blob/5717523b9ea7a2d76efbd6eb73414de9c06c6f96/server/src/services/issue-dependency-wakeups.ts) 将依赖状态和本次阻塞周期编码到唯一键，防止重复唤醒，也避免旧周期抑制新工作。
- [待处理消息队列](https://github.com/paperclipai/paperclip/blob/5717523b9ea7a2d76efbd6eb73414de9c06c6f96/server/src/services/issue-queued-comment-queue.ts) 记录消息身份和队列版本，修改后重新构造派工上下文。
- [成本和预算](https://github.com/paperclipai/paperclip/blob/5717523b9ea7a2d76efbd6eb73414de9c06c6f96/docs/guides/board-operator/costs-and-budgets.md) 提供提醒及达到上限暂停的模式。

应用到本项目：负责人待处理事件箱、任务级累计执行与耗时上限、重复通知去重。CLI 未提供 usage 时显示“未报告”，不能把缺失值当作零费用；先采用执行次数、耗时和已报告用量等可核查指标。

### Microsoft Agent Framework：识别空转并有限重规划

[microsoft/agent-framework](https://github.com/microsoft/agent-framework) 的 Magentic 协调器有进度账本、停滞判断、重规划以及累计轮数限制。

- [进度与停滞处理](https://github.com/microsoft/agent-framework/blob/40763bed1a5e94a1698ba9ebf009e5622eb099aa/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L1080)。
- [轮数与重规划上限](https://github.com/microsoft/agent-framework/blob/40763bed1a5e94a1698ba9ebf009e5622eb099aa/python/packages/orchestrations/agent_framework_orchestrations/_magentic.py#L1250)。

应用到本项目：结合产物版本未变、重复验收错误、重复计划和新增证据判断是否空转。改派不重置累计预算。模型的“任务已满足”只是判断意见，不能直接标记机器验收通过。

[AutoGen 当前 README](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md#L19) 已声明维护模式并指向 Agent Framework，因此建议借鉴具体机制，不为本项目新增 AutoGen 依赖。

### 另外两个常见候选的现状

- [Superset](https://github.com/superset-sh/superset/blob/2e4784202bc61c9832333589597ad7890e7b836b/README.md) 的工作区、终端、预览、diff 行反馈和原会话继续值得参考，但官方明确 Windows 尚不可用、Linux 为实验性。其 [编排说明](https://github.com/superset-sh/superset/blob/2e4784202bc61c9832333589597ad7890e7b836b/plugins/superset/skills/orchestrate/SKILL.md) 将依赖和完成状态留在负责人上下文，终端 DONE/BLOCKED 约定不等于宿主持久状态。项目采用 Elastic License 2.0。
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban/blob/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a/README.md) 当前已有 Tauri 桌面及 Windows 发布路线，README 顶部同时宣布正在退场（sunsetting）。适合作为任务、执行和评审视图参考，不宜成为本项目未来的核心依赖。

桌面候选的调研过程保存在本地研究记录中，未随源码仓库发布。

## 建议的实施批次

### 第一批：把求助接起来

1. 持久化成员问题、负责人决定和答复；关联原任务、原步骤、运行及计划版本。
2. 负责人可以答复、请求授权同伴分析、调整尚未执行的分工；正在执行的工作需先按现有暂停流程停稳。
3. 回执只恢复对应步骤；事件去重并设置求助轮数上限。只在确实缺少用户信息或授权时转交用户。
4. 桌面增加“需要处理”入口，直接显示谁在等谁、问题是什么、答复是否已送达。

验收案例：前端成员缺少接口字段，向负责人提问；负责人向后端成员核实后给出答复，前端恢复原步骤；重复事件不重复执行，取消后晚到答复不重新派工。

### 第二批：检查成果并从有效步骤继续

1. 每步记录预期结果；对文件交付检查存在性、格式和版本，对分析交付检查规定的内容字段。
2. 依赖步骤仅消费有效交付；这些检查与最终机器验收、独立评审分别记录。
3. 保存步骤检查点，区分临时执行故障和内容返工；重试次数分别可见，并受任务累计上限约束。
4. 只重跑失败或证据已失效的步骤以及受影响的后继。

验收案例：三步任务完成前两步，第三步超时；继续后前两步文件及执行次数保持不变。若第二步输入发生变化，则第二步及第三步重新执行。任何未配置或跳过的检查显式显示。

### 第三批：让选人与桌面操作更顺手

1. 成员卡展示技能标签、自由描述、当前负载和最近连接状态；推荐成员附理由，用户可覆盖。
2. 任务顶部显示当前负责人、阶段、具体等待对象和下一步动作；决策与成果可直接打开。
3. 将沟通、派工、交付、检查、改派串成任务时间线；日志作为需要时展开的证据。
4. 用“已有有效交付的步骤数／计划步骤数”表示进度，不制造模型完成百分比。
5. 增加受控的真实客户端小任务验收，记录实际完成率、重复执行数、恢复次数和人工介入次数，分别列出不同适配器的结果。

并行写入适合后续单独处理：先支持互不冲突的只读分析；代码任务如引入 worktree，应同时实现差异审阅、集成及冲突处理。worktree 用于减少文件冲突，不是操作系统权限隔离。

调研原始文本与版本信息保存在 `work/github-research-20261008/` 及其他研究子目录，未执行任何候选仓库中的安装或启动脚本。
