# 2026-10-14 任务操作与失败恢复检查

继续按用户要求，从实际操作检查任务创建、启动、取消、作业终止、调整分工、验收、返工和页面往返。本轮修改源码与开发资源，未打包。测试均使用项目内独立工作目录，没有启动原工作区服务或操作用户原任务。

代码与测试执行于 10 月 14 日，10 月 15 日继续核对最终证据并完成记录。

## 本轮改进

| 操作中发现的问题 | 改进后的行为 |
| --- | --- |
| 启动、验收和返工失败使用系统弹框，成功后又直接关闭详情 | 在原任务显示错误或结果，输入保留；成功后继续查看进度、文件和验收意见 |
| 取消确认替换掉原任务或日志，失败仍关闭；处理中 Escape、遮罩和关闭按钮行为不一致 | 确认框保留底下页面；失败原地重试，关闭后返回原处；处理中统一锁定关闭，默认焦点在返回按钮 |
| 回执丢失时误报失败，用户重试可能重复操作 | 先读取实际状态，不自动重复提交；无法核对时拦住下一次变更，提供刷新状态入口 |
| 较晚返回的启动结果或旧页面刷新覆盖新状态 | 已暂停的任务保持暂停；切到归档页后，旧操作的刷新使用当前页面条件；其他任务的输入不会被迟到结果清空 |
| 改派选项和原因在查看日志、切换任务或刷新后丢失 | 分工草稿按工作区、任务和执行上下文保存；未应用前阻止按旧成员启动，可明确恢复当前分工 |
| 分工未变化仍可重复保存；改派已保存但回执丢失后，继续按钮被残留草稿卡住 | 未变化时不提交；丢失回执后同时核对成员和改派说明，确认已保存才清理草稿，不重复改派 |
| 验收成功后的草稿清理失败没有可用入口，可能拦住退出 | 在已完成任务中提供“重试清理草稿”，只清理对应草稿，不重复验收；已验证退出保存握手恢复 |
| 输入法使用 Escape 取消选字时，新建任务可能关闭 | 组合输入期间保留表单，普通 Escape 仍保存后离开 |
| 作业终止提示没有交代讨论整体的影响范围 | 明确说明结束讨论会停止本轮其他作业；普通作业和关联任务按实际停止范围提示 |

取消确认抽为 ActionConfirmDialog，启动、验收和返工共用结果处理。改派复用原有草稿服务及任务操作锁；没有增加新的执行授权存储。原有视觉布局继续保留。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| npm test | **312 通过，0 失败，0 跳过**，428.6 秒；[日志](../../work/task-actions-ux-20261014/npm-test-final.log) |
| npm run check | 通过；[最终类型检查](../../work/task-actions-ux-20261014/check-complete.log) |
| npm run build | 通过；开发资源 index-Dpw88n-s.js、index-Bs5-0QEr.css；[最终构建](../../work/task-actions-ux-20261014/build-complete.log) |

| 桌面流程 | 结果 | 证据 |
| --- | --- | --- |
| 任务操作与失败恢复 | 22 条全部通过 | [回执](../../work/desktop-smoke/run-69C2tQ/desktop-smoke.json) |
| 任务协作与改派 | 通过 | [回执](../../work/desktop-smoke/run-YBihCB/desktop-smoke.json) |
| 协助与恢复 | 通过 | [回执](../../work/desktop-smoke/run-nReA89/desktop-smoke.json) |
| 材料、草稿与真实键盘 | 通过 | [回执](../../work/desktop-smoke/run-TuOzVh/desktop-smoke.json) |
| 主控托管 | 通过 | [回执](../../work/desktop-smoke/run-IMJCu9/desktop-smoke.json) |
| 聊天工作台 | 通过 | [回执](../../work/desktop-smoke/run-w1kpyO/desktop-smoke.json) |
| 日常操作与成果下载 | 通过 | [回执](../../work/desktop-smoke/run-3ttrjx/desktop-smoke.json) |

全量程序测试之后，补齐了终止范围说明、完成页验收记录，以及改派回执丢失后的核对。这些最后的界面变化由最终 22 条桌面流程、重新运行的任务协作场景及类型检查、开发构建覆盖；没有把较早的全量程序测试说成后续全部界面变化的执行证据。

两条新增的服务回归已包含在 312 项中：分工草稿跨窗口恢复并按任务、执行上下文隔离，不能携带执行或验收授权；已保存分工的草稿清理失败后可恢复，并采用新分工默认值，不回退旧成员或启动任务。[18 项草稿定向测试](../../work/task-actions-ux-20261014/draft-tests-first.log)也全部通过。

22 条最终任务流程覆盖：输入法 Escape、启动失败重试、启动回执丢失、未知状态先核对、迟到启动与暂停、迟到刷新与归档页、取消后返回、取消期间的关闭锁、取消回执恢复、真实 Tab/Escape、1040×700 窗口及 100%/125%/150% 缩放、终止作业后返回日志、终止回执恢复、改派草稿往返与刷新、分工草稿放弃及隔离、改派回执恢复、验收失败、验收回执恢复、返工失败、返工回执恢复、提交中切换任务，以及验收后草稿清理与退出恢复。

本轮桌面验证使用真实 Electron、本地服务及 SQLite。6 个预先登记的固定文件作业产生实际交付文件，故障通过指定请求的失败、延迟或丢失回执注入；并非真实模型调用或多模型验收。此前 DSH 官方默认模型的真实首轮、续接和文件任务成功证据保留在[上一轮记录](2026-10-14-ux-audit.md)，本轮没有改动模型默认值或官方客户端配置。

## 可查看的界面证据

- [取消失败仍保留任务](../../work/desktop-smoke/run-69C2tQ/task-actions-cancel-inline-error.png)
- [恢复后的分工草稿](../../work/desktop-smoke/run-69C2tQ/task-actions-restored-assignment.png)
- [完成后继续查看验收记录](../../work/desktop-smoke/run-69C2tQ/task-actions-acceptance-complete.png)
- [验收已完成时重试草稿清理](../../work/desktop-smoke/run-69C2tQ/task-actions-cleanup-after-acceptance.png)
- [最小窗口的 150% 缩放](../../work/desktop-smoke/run-69C2tQ/task-actions-confirmation-150-percent.png)

截图中的 TASK_ACTIONS_... 是固定测试内容或故障标记。

## 失败记录与测试工具调整

- [修改前的界面复现](../../work/task-actions-ux-20261014/desktop-before-fixed-driver.log)保留了输入法误关、系统弹框、取消丢失页面、关闭锁不一致及回执恢复缺失等失败。该批中两项最初使用了过期页面节点或错误日志入口，不能计为产品缺陷。
- 最初隐藏窗口截图等待绘制被挂起，测试工具改为使用 Electron 的 stayHidden/stayAwake 选项，再读取当前帧；[最初日志](../../work/task-actions-ux-20261014/desktop-before.log)保留。
- 并行桌面运行时，一次真实键盘检查没有取得预期 Tab 焦点；保持同一开发构建单独重跑后全部通过。最后涉及真实键盘的检查串行进行；[原失败](../../work/task-actions-ux-20261014/desktop-usability-final.log)和[单独复验](../../work/task-actions-ux-20261014/desktop-usability-isolated.log)均保留。
- 一次状态检查在按钮仍显示“正在启动”时过早查找“启动任务”，结果误报失败。回执截图显示按钮已禁用；测试现在核对两种进行中/完成标签的禁用状态，[原日志](../../work/task-actions-ux-20261014/desktop-delivery.log)保留。最终 22 条使用调整后的检查再次通过。

## 文件与运行范围

修改前文件位于 work/task-actions-ux-20261014/before/；[机器汇总](../../work/task-actions-ux-20261014/validation-results.json)记录最终回执、资源与源码哈希。没有运行 package:desktop 或 dist:desktop；release/latest-desktop.json 和根目录快捷方式的 SHA-256 与本轮开始时完全相同。

现有快捷方式仍打开 10 月 13 日成品。本轮结果通过项目目录的 npm start 使用源码和开发构建，未替换现有安装包。
