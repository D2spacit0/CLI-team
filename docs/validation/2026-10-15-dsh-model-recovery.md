# 2026-10-15 DSH 旧模型会话恢复修复

用户在已有聊天室继续对话时，DSH 报错：`pi-ai provider "local" has no configured model "Qwen3.8-27B"`。旧原生会话保留了 `local/Qwen3.8-27B`，当前官方配置已改为 `local/qwen38`。DSH 0.2.0-rc.2 在恢复阶段先校验旧模型，导致工作台尚未来得及选择当前模型就退出。本轮请求未发送给模型。

此前成品检查覆盖了固定执行器和新会话接入，漏掉了“旧会话保留已移除的模型”这个实际使用场景。原有绿色结果不能证明此场景可用；本次先使用旧成品和已安装的 DSH 复现相同错误，再验证修复。

## 修复行为

- 仅对原生恢复阶段的 `UNKNOWN_MODEL` / `NO_ADAPTER` 启用兼容处理，使用成员明确选择的模型；成员使用官方默认时，使用当前默认模型。
- 兼容层仅在官方 DSH 子进程的 ACP 模型选项查询中生效。通过标准 `session/set_config_option` 切换并核对响应后，才发送一次请求。实际模型派发没有旧名称别名。
- 保留原会话 ID、完整历史和官方模型切换记录。已有可用模型的会话继续沿用原配置；会话占用、无效新模型、认证及网络错误不会触发任意回退。
- 不修改官方安装或模型配置，不复制登录凭据，不手工改写原生日志，不重置用户会话，也不自动重发失败任务。执行记录显示原模型、恢复模型和切换确认状态。

主要实现：`server/dsh-resume-model.mjs`、`server/dsh-acp-resume-bridge.mjs`、`server/dsh-runner.mjs`。新增单元和协议回归覆盖恢复确认、仅发送一次、无效目标、错误会话、原模型派发不可被别名掩盖、配置保密及失败处理。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 335 通过，0 失败、0 跳过、0 取消 | [完整日志](../../work/dsh-model-incident-20261015/npm-test.log) |
| `npm run check` / `npm run build` | 通过 | [构建记录](../../work/dsh-model-incident-20261015/check-build-results.json) |
| 已安装 DSH + 固定模型端点 | 复现旧成品错误；恢复后同一会话、历史及实际请求模型正确；真实原生写锁未绕过 | [记录](../../work/dsh-model-incident-20261015/installed-resume.json) |
| 修正版成品 + 官方实际模型服务 | 2 轮真实模型对话通过，保留旧上下文中的随机验证值；普通 ACP 配置启用，成员权限为只读 | [记录](../../work/dsh-model-incident-20261015/packaged-real-resume.json) |
| 用户失败会话的完整副本 | 同一原生 ID 恢复成功；358 条事件保留，原文件、副本及应用映射均未改变；模型请求数为 0 | [记录](../../work/dsh-model-incident-20261015/packaged-original-copy.json) |
| 成品聊天工作台 | 加载、桥接、聊天及历史恢复、草稿保存和正常退出通过；真实模型调用为 0 | [桌面回执](../../work/desktop-smoke/run-96xjzt/desktop-smoke.json) |
| 成品与已测源码 | 60 个运行文件一致，181 个源码/测试/构建文件未变化，内置 Node 核对通过 | [记录](../../work/dsh-model-incident-20261015/package-verification.json) |
| 原快捷方式 | 已指向修正版，原参数和工作目录保留，旧成品目录保留 | [记录](../../work/dsh-model-incident-20261015/shortcut-verification.json) |

成品聊天场景首次执行停在延迟请求注入：注入规则匹配下一次 `after` 请求，可能被 SSE 的 300 ms 自动刷新先触发；脚本随后等待点击已被该延迟请求禁用的刷新按钮，形成测试时序冲突。[首次失败现场](../../work/desktop-smoke/run-fBMsNw/history-result.json)和[原始日志](../../work/dsh-model-incident-20261015/packaged-workbench-attempt1.log)均保留。相同成品、相同断言单独重跑后完整通过，包括 10 项历史恢复检查；没有修改产品代码或放宽断言。

固定端点验证与真实模型验证分别记录。真实回复是否包含随机上下文内容由脚本比较，模型声称“已恢复”不作为依据。真实验证对应已安装 DSH `0.2.0-rc.2`；没有验证其他客户端版本。没有重新发送用户的章节修改任务。

## 使用修正版

构建时间：2026/10/15 17:13:20（Asia/Shanghai）。程序：[CLI Team.exe](../../release/2026-10-15T09-12-58-138Z/CLI%20Team-win32-x64/CLI%20Team.exe)。快捷方式：[CLI Team 桌面端.lnk](../../CLI%20Team%20桌面端.lnk)。

关闭正在运行的旧窗口，再通过原快捷方式打开修正版，然后给 DSH 重发需要继续的消息。已有成员、聊天、任务和章节文件继续使用原工作目录。

前端资源：`index-DxG5WHzr.js`、`index-YRYka0gy.css`。应用版本仍为 0.1.0；本次运行文件以新构建目录和哈希记录区分。旧版发布验证保留在[当日首次打包记录](2026-10-15-desktop-release.md)。本次成品界面重跑聊天工作台，其他主控交付及任务操作场景没有重复执行。

完整机器汇总：[validation-results.json](../../work/dsh-model-incident-20261015/validation-results.json)。
