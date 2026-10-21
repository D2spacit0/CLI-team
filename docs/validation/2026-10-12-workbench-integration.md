# CLI Team 接入与工作台行为回归

2026-10-12。已完成接入和数据一致性修改；视觉与布局由 Gemini 接续设计。交接入口见[前端任务书](../plans/2026-10-12-gemini-frontend-brief.md)。

## 实际改动

- Antigravity 解析支持嵌套及扁平 init / step_update / result，保留 text_delta 中的空格、换行和结构化报告。终结帧未重复正文时保留增量，有完整正文时替换。成功仍需明确 SUCCESS、正常进程退出、有效报告和无风险标记。其他 CLI 协议不能覆盖 Antigravity 的失败或缺失终结状态。
- 草稿服务新增 room-message scope，以工作区与房间隔离正文、收件人和关联任务；不保存执行与验收授权。已有版本冲突、退出保存及重试逻辑继续生效。
- 消息发送捕获原房间和原草稿，延迟回执不会清空另一房间输入。HTTP 与 SSE 的同一消息按 ID 去重；正文提及和勾选成员合并预览，缺失或停用成员阻止发送。
- 界面已有功能骨架：连续聊天、真实计划与依赖、任务/材料/成果/日志侧栏。原 TaskCoordination、TaskAssistance、TaskMaterials、TaskAssignment 等操作继续复用。
- 消息列表在阅读历史时保留位置，切回房间保留新消息提示；跟随最新时适应窗口变化。组合输入期间 Ctrl+Enter 不发送。
- 验收备注对齐服务：必填且最多 2000 字；pending / failed / stale 机器检查或未通过的独立评审均阻止接受。日志页区分排队、运行及退出代码。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| npm test | 251 通过，0 失败、跳过、取消、todo | [完整日志](../../work/workbench-implementation-20261012/npm-test.log) |
| npm run check | 通过 | [类型检查](../../work/workbench-implementation-20261012/npm-check.log) |
| npm run build | 通过 | [构建日志](../../work/workbench-implementation-20261012/npm-build.log) |
| --workbench-smoke | 通过；延迟发送、草稿隔离、失败重试、消息去重、组合输入、历史滚动及任务/日志侧栏 | [收据](../../work/desktop-smoke/run-DOmhAQ/desktop-smoke.json) |
| --usability-smoke | 通过；任务准备、材料失败重试、任务草稿与日志/成果返回、退出保存握手 | [收据](../../work/desktop-smoke/run-8wEYWJ/desktop-smoke.json) |
| --coordination-smoke | 通过；暂停、停稳后改派、继续排队、保留文件和日志返回 | [收据](../../work/desktop-smoke/run-swrdNS/desktop-smoke.json) |
| --assistance-smoke | 通过；人工求助、负责人答复、局部恢复、分析结构检查及日志去重 | [收据](../../work/desktop-smoke/run-1O50Rx/desktop-smoke.json) |

四组桌面场景均检查渲染页、安全桥、退出草稿保存、本地服务退出及工作区锁释放。工作台覆盖 1440×900 和 1040×700 窗口，以及 100% / 125% / 150% Chromium 页面缩放；确认页面无横向溢出、发送按钮可见。未改变 Windows 显示缩放；输入法覆盖浏览器组合事件，没有进行真实输入法人工验收。

桌面测试使用独立 work/desktop-smoke 目录。工作台及改派场景没有启动 CLI；使用流程场景运行 11 次固定执行器，求助场景运行 14 次固定执行器，真实模型调用均为 0。这些结果不构成真实 Antigravity 或其他模型的协作验收。

最终前端资源为 index-vVUtoC_B.js 与 index-jRxjNyBx.css。对应源码校验值见 [source-hashes.json](../../work/workbench-implementation-20261012/source-hashes.json)。本轮未生成新的桌面安装包。

## 仍需后续实现

正文增量当前在执行器内部聚合，前端 SSE 仍为通知后重读。原生问答/权限回送、事件回放、逐收件人投递状态、消息分页和聊天发送幂等键仍未实现。当前去重处理同一消息的重复读取，不承诺网络中断后重新提交具有幂等性。

Gemini 可以重做布局与基础样式，保留接口与业务保护；视觉稿和新增交互需要在其改动后重新验证。
