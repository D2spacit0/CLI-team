# CLI 接入与默认模型修复

本轮把 CCGUI 研究中的入口识别、能力检查、原生会话身份和错误分层落实到 CLI Team 的接入代码。模型默认跟随官方 CLI；只有用户在工作台选择具体模型时才覆盖。既有协作、权限与独立验收流程保持原有语义。

## 实际问题与修复

| 问题 | 改动 |
| --- | --- |
| 只找到 node.exe 就显示 CLI 已安装 | 验证 JS 入口是否为存在的绝对文件路径；缺少入口时不能派工 |
| Windows npm 的无扩展名 shell shim 被当成程序 | 跳过无法由 CreateProcess 启动的 shim，继续查找官方 npm 包入口；本机 Codex 已通过版本检查 |
| “已检测”混同于可调用模型 | 新增“检查接入”，分别记录入口、启动、协议、模型配置、认证；没有做的检查显示“未检查” |
| DSH 的 settings.yaml 已迁移到 desktop profile，旧接入没有读取 local provider | 在官方 DSH 子进程内加载只读模型配置桥接，引用原文件，只读取 agent-default-model、llm-pi-ai、llm-deepseek 三个模型命名空间 |
| 模型被写成固定名称 | 新成员跟随 CLI 默认；下拉列表来自实际 ACP 返回，可显式指定，也可恢复默认；其他 CLI 可明确手动指定其支持的标识 |
| ACP 错误只剩 Internal error | 保留脱敏后的 error.data.details、协议方法、错误码、失败阶段和处理建议 |
| 恢复失败仍返回旧会话 ID，容易误判已恢复 | 分开记录请求恢复的 ID 与客户端实际确认的 ID；失败时不改原映射，不自动新建或重发 |
| 旧会话模型已被官方配置移除 | 日志提供明确的重置操作；校验该作业仍对应当前映射，只解除该阶段映射，保留原生会话和其他阶段 |

参考：CCGUI 固定快照 `6100b177b1e913c45ca108dc0746f161f11b6cb0` 的 engine、registry、events、DSH 配置发现及会话分层；背景见 [研究记录](../research/2026-10-12-ccgui-multi-cli-studio.md)。本轮为独立实现。

## 模型行为

- `member.model` 为空：不传 `--model`，DSH 不发送 `session/set_config_option`。新会话按官方配置创建，恢复会话沿用其原生模型配置。
- 用户选择模型：使用客户端返回的完整供应商/模型标识。未唯一匹配时停止，保留模型列表供选择，不猜测别名。
- DSH 配置来源可选自动、ACP、桌面端、Web。自动按 ACP → desktop → web 查找具有模型配置的 profile；再应用 home 共用配置和仍存在的旧 settings.yaml。
- 官方 profile 的 UI、工具、权限和任意插件不被带入 CLI Team。官方凭据继续由官方凭据 provider 按原路径读取，没有复制到工作台数据或日志。
- 根据用户最后确认的交互要求，DSH 成员已从过期固定值 `Qwen3.8-27B` 改为跟随 CLI 默认（空覆盖值）；没有固定成 `local/qwen38`。

## 实机证据

截图对应的旧运行是 `run-5bcd393d-5dcd-43ab-96fa-91e38776f565`。未发送任务的受控恢复探测复现了 `session/resume` 返回 `no adapter registered for provider "local"`。接入官方配置后，这个旧会话又明确报告其历史模型 `Qwen3.8-27B` 已不在当前 provider 配置中。原会话和映射均保留，没有自动重置。

跟随 CLI 默认的新会话已完成真实 DSH 请求；随后恢复同一会话，第二轮在未提供第一轮答案的情况下返回了第一轮的固定验证文字。两轮均未设置模型覆盖，当前官方配置实际选择了 `local/qwen38`。这是连接和上下文恢复验证，不代替项目任务的独立验收。

实机记录：

- [默认模式首轮](../../work/cli-integration-20261013/verified/live-request.json)
- [同一会话恢复及上下文验证](../../work/cli-integration-20261013/verified/live-resume.json)
- [旧会话恢复诊断](../../work/cli-integration-20261013/original-session.json)
- [已发现客户端版本检查](../../work/cli-integration-20261013/installed-clients/results.json)

本机自动发现路径范围内，Antigravity 1.2.6、Codex 0.159.0 通过启动/版本检查；Claude、Gemini、OpenCode 未发现，不宣称其认证或真实模型调用已通过。

## 验证与交付

| 验证 | 结果与范围 |
| --- | --- |
| `npm test` | 279/279 通过，0 失败、0 跳过。全量启动后补充的 Windows npm shim 修复及新增回归，由最终 26/26 项定向测试覆盖；未再次重跑包含该新增用例的全量测试 |
| `npm run check` | 最终源码 TypeScript 检查通过 |
| `npm run build` | 最终源码构建通过，产物为 `index-BDVhjTwz.js` 与 `index-BxuRK3H_.css` |
| 源码桌面操作 | 接入检查、真实协议 fixture 返回的模型选择、保存和恢复 CLI 默认，以及原有工作台交互通过 |
| 成品桌面操作 | 同一模型选择流程在打包成品通过；另通过托管协作 fixture 场景，包括恢复、返工和机器验收流程。两种桌面测试均未调用真实模型，不作为真实多模型协作证据 |
| 成品实际 DSH 接入 | 使用成品内置 Node 24.12.0 和成品服务模块，官方 DSH 0.1.5-rc.1 的入口、启动、ACP 握手、模型配置检查通过；返回 5 个真实模型选项，`requestedModel` 为 `null`，默认由官方配置选择 `local/qwen38`。未发送任务，认证状态明确为未检查 |
| 成品文件核对 | 51 个服务、桌面、工具和构建文件与最终源码逐一 SHA-256 一致；运行依赖清单一致；最新前端的 `tokens.css` 和 `workbench.css` 保持原 hash |

新版桌面程序位于本次构建的 `release` 目录中。项目快捷方式已更新并核验指向该版本，旧快捷方式已备份。保留完整程序目录使用。

验证记录：

- [全量测试](../../work/cli-integration-20261013/npm-test.log)、[最终入口专项测试](../../work/cli-integration-20261013/focused-test.log)、[类型检查](../../work/cli-integration-20261013/npm-check.log)、[构建](../../work/cli-integration-20261013/npm-build.log)
- [成品工作台操作回执](../../work/desktop-smoke/run-0KoB2K/desktop-smoke.json)、[成品托管协作 fixture 回执](../../work/desktop-smoke/run-ueRNAH/desktop-smoke.json)
- [成品文件与真实 DSH 握手核验](../../work/cli-integration-20261013/package-verification.json)、[快捷方式更新回执](../../work/desktop-shortcuts/update-6YKqOS/receipt.json)

源码与数据改动备份位于 `work/cli-integration-20261013/before/` 及该目录下的模型配置回执。截图中旧会话仍引用已经移除的 `Qwen3.8-27B`；本轮保留该会话和映射，由用户在日志中明确重置后再创建新会话，或自行恢复官方旧模型配置。

## 本轮范围

DSH 保留 ACP 双向协议，并补齐官方配置来源、实际模型选项和会话诊断。Claude / Gemini / Antigravity 保留 stream-json，Codex 保留 exec-json，OpenCode 保留 run-json；本轮没有把它们迁移为 CCGUI 的全部长驻传输方式。其他 CLI 的接入检查只启动版本命令，不发送模型任务，不将版本成功写成认证通过。自定义 CLI 只检查入口，不执行未知的探测命令。
