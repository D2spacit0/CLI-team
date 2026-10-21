# 主控托管闭环交付记录

2026-10-12。实现了“一次配置团队 → 提交目标 → 主控拆解与派发 → 逐项审查和返工 → 汇总、验收与终审 → 交付”。沿用 Gemini 的中文工作台设计，增加实际任务入口和状态展示。

2026-10-13 更新：Gemini 最后一次前端修改已另行接入和重新打包，最新程序与回归结果见 [Gemini 前端接入记录](2026-10-13-gemini-frontend-integration.md)。本文保留首轮托管实现的验证历史。

## 使用入口

在“工作区设置 → 主控与协作团队”选择主控、1–4 名协作者、可选独立评审者，以及预先约定的检查程序和参数。之后点击顶栏“交给主控”或任务页“提交目标”。CLI 对应 `configure-team` / `submit`，MCP 对应 `team_configure_controller` / `team_submit_objective`。具体示例见 [README](../../README.md)。

主控是可运行的 CLI 成员，可以使用已有适配器；不是仅代表外部调用者的 `codex-controller` 记录。不会自动启用原来停用的成员。团队配置复制到新任务，后续改配置不改变在途任务。

## 实际行为

- `POST /api/requests` 接受 UUID `requestId`、`objective`，以及可选 `title` / `roomId`。创建任务、保存请求回执、排队规划在同一 SQLite 事务中完成。重试返回原任务，即使团队配置已改变；不同内容复用 ID 返回冲突。
- 目标及请求 ID 使用现有草稿服务保存。回执不明时冻结原目标，重试核对原请求；不会把一次失败的回执变成第二次派工。
- 每个托管步骤必须声明文件或分析交付约定。成员退出后先做结构和版本检查，再安排独立的主控 `step_review` 作业。主控读实际成果，提出具体修正；文件检查失败不能被主控的一句“通过”覆盖。
- 局部返工保留文件、依赖和主控审查都有效的其他步骤；终审发现整体问题时重新规划。所有自动返工使用同一份 `repairLimit` 额度，耗尽后阻塞并保留原因。
- 汇总、机器验收和可选独立评审结束后安排主控 `final_review`。机器证据、产物版本、独立评审和主控结论共同满足条件时，经过原 `acceptTask` 检查后自动交付。
- 未配置检查或缺少完整证据时保持待验收；检查失败或产物变化不能自动通过。终审前产物已变化时，旧 gate 明确标为 `stale`。关闭自动交付则留待人工接受。
- 暂停和取消后的迟到审查结论被忽略。重启不自动重放；明确继续时，文件检查通过而缺少有效主控审查记录的步骤不能复用。
- 任务详情展示逐项主控审查、返工理由、当前阶段、终审日志和交付成果。新建频道同步更新路由，刷新后仍回到该频道。

## 验收层次

| 记录 | 可以证明什么 |
| --- | --- |
| CLI 作业结束 | 本次执行及协议是否正常；不等于任务完成 |
| `outputCheck` | 约定文件或分析结构、哈希是否匹配；不证明内容正确 |
| `ownerReview` / 独立评审 | 对具体产物的模型判断，仍与机器事实分开保存 |
| `gate` / evidence | 预先配置的检查程序结果、测试计数、跳过数量及产物版本 |
| `delivery` | 主控最终报告、成果引用、证据与接受状态；不改变原始证据 |

自动交付要求 evidence 属于当前任务和版本，`passed:true`、`skipped:0`，配置的独立评审通过，主控终审通过且没有重大问题。关闭自动交付时仍执行全部审查，只保留最后的人工接受。

## 验证结果

| 检查 | 结果 | 记录 |
| --- | --- | --- |
| `npm test` | 268 通过，0 失败、跳过、取消、todo | [全量日志](../../work/supervision-implementation-20261012/npm-test.log) |
| 主控边界回归 | 16 通过，覆盖定向返工、暂停、取消、终审版本漂移、重启与回执去重 | [边界日志](../../work/supervision-implementation-20261012/managed-boundaries.log) |
| 交付身份定向回归 | 1 通过；交付消息使用实际配置的主控名称 | [定向日志](../../work/supervision-implementation-20261012/managed-delivery-identity.log) |
| `npm run check` | 通过 | [类型检查](../../work/supervision-implementation-20261012/check.log) |
| `npm run build` | 通过 | [构建日志](../../work/supervision-implementation-20261012/build.log) |
| 开发版 `--managed-smoke` | 通过，配置、草稿、请求重试、审查和交付 | [收据](../../work/desktop-smoke/run-PSwiTt/desktop-smoke.json) |
| 开发版 `--workbench-smoke` | 通过，频道创建与刷新、聊天草稿、延迟回执、失败重试、组合输入、历史滚动、任务与日志侧栏 | [收据](../../work/desktop-smoke/run-FT6ddk/desktop-smoke.json) |
| `npm run package:desktop` | Windows x64 桌面包生成成功 | [打包日志](../../work/supervision-implementation-20261012/package-desktop.log) |
| 成品 `--packaged --managed-smoke` | 通过，正式桌面包完整托管交付 | [收据](../../work/desktop-smoke/run-gk667u/desktop-smoke.json) |

真实进程集成测试与托管桌面场景均使用固定 Node 协议程序，完成 8 次作业：规划 → 成员执行 → 主控退回 → 成员返工 → 主控复查 → 汇总 → 独立评审 → 主控终审；另有独立 Node 验收检查产物。每个场景发生 1 次返工，交付时机器检查与独立评审均通过。模拟丢失成功响应后重试，任务数始终为 1；清除后续团队配置也不妨碍恢复原请求。

桌面测试使用正式 Electron 窗口、preload 和本地服务。每次使用独立 `work/desktop-smoke/run-*` 数据，退出后确认服务停止且锁释放，没有更改产品 `.team` 数据。

缩放采样先触发隐藏窗口绘制，再核对 CSS 视口与窗口内容尺寸，避免记录旧布局。在 1040×700 窗口、100% / 125% / 150% 页面缩放下，实际视口分别为 1024×661、819×529、683×441；目标提交按钮可见，聊天工作台无页面横向溢出且发送按钮可达。另覆盖 1440×900 工作台。未调整 Windows 显示缩放。

## 桌面交付

程序：[CLI Team.exe](../../release/2026-10-12T09-20-39-424Z/CLI%20Team-win32-x64/CLI%20Team.exe)。请保留整个程序目录。最新路径同步到 [latest-desktop.json](../../release/latest-desktop.json)。

前端资源为 `index-Cv_sNjBn.js` 和 `index-CbsTZpVC.css`。源码校验值记录在 [source-hashes.json](../../work/supervision-implementation-20261012/source-hashes.json)。

## 验证范围

本轮真实模型调用为 0。固定进程和桌面回归验证调度、状态保护、文件检查及界面操作，不代表各官方模型的协作质量已经验证。官方 CLI 的安装、登录和模型可用性仍由客户端实际状态决定，凭据继续由客户端管理。

旧 direct / delegated 模式及原任务历史保留。托管任务在自己的任务目录内执行，目录分离不是操作系统沙箱，也不会接管正在运行的外部会话。原生双向权限回送、完整事件回放等 v2 提案仍是后续工作，本轮不宣称已实现这些能力。
