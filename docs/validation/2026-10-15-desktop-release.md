# 2026-10-15 桌面发布记录

按用户要求，将当前项目打包为 Windows x64 桌面版。构建时间为 2026-10-15 15:48（Asia/Shanghai），应用版本保持 `0.1.0`，内置 Electron 44.7.0 和 Node.js 24.12.0。

## 启动入口

双击项目根目录的 [CLI Team 桌面端.lnk](../../CLI%20Team%20桌面端.lnk) 即可启动本版。快捷方式已核对指向新成品，原有启动参数及工作目录保留，旧版程序目录未删除。

直接程序：[CLI Team.exe](../../release/2026-10-15T07-48-01-406Z/CLI%20Team-win32-x64/CLI%20Team.exe)。程序目录约 516.1 MiB，移动时请保留整个 `CLI Team-win32-x64` 文件夹；无需另装 Node.js。

## 本版内容

- 日常操作中的设置保存、成员配置、讨论草稿、日志、成果下载和会话同步恢复。
- 任务启动、取消、改派、验收与返工的反馈和重试。
- 聊天历史分页、断线补读、阅读位置保留及小窗口优化。
- 主控目标草稿恢复、团队配置往返、提交超时去重，以及任务提交后的独立草稿清理。

实现与开发验证分别见[日常操作检查](2026-10-14-ux-audit.md)、[任务操作检查](2026-10-14-task-actions-ux.md)、[聊天历史优化](2026-10-15-message-history.md)和[主控目标优化](2026-10-15-managed-request-ux.md)。本次打包没有修改运行代码。

## 检查结果

源码和开发构建在本次打包前已完成 `npm test`、`npm run check` 和 `npm run build`。本次核对上轮验证记录的 14 个文件哈希，并确认运行代码及测试没有在完整测试结束后变化；沿用该次 324 项全部通过的结果，没有重复运行相同源码测试。打包前后另外核对了 177 个源码、测试及构建文件。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 324 通过，0 失败、0 跳过、0 取消 | [沿用的完整日志](../../work/managed-ux-20261015/npm-test-final.log) |
| `npm run check` | TypeScript 检查通过 | [沿用的日志](../../work/managed-ux-20261015/check-final.log) |
| `npm run build` | 开发构建通过，前端产物哈希一致 | [沿用的日志](../../work/managed-ux-20261015/build-final.log) |
| `npm run package:desktop` | 新目录生成成功，快捷方式更新成功 | [打包日志](../../work/desktop-release-20261015/package-desktop.log) |
| 成品 `--managed-request-smoke` | 16 项主控目标操作及故障恢复通过 | [回执](../../work/desktop-smoke/run-6d08uk/desktop-smoke.json) |
| 成品 `--workbench-smoke` | 聊天工作台及 10 项历史消息检查通过 | [回执](../../work/desktop-smoke/run-5Sq02i/desktop-smoke.json) |
| 成品 `--task-actions-smoke` | 22 项任务操作检查通过 | [回执](../../work/desktop-smoke/run-qoaXQT/desktop-smoke.json) |
| 成品 `--managed-smoke` | 主控规划、审查、1 次返工、机器检查及最终交付通过 | [回执](../../work/desktop-smoke/run-DEdES9/desktop-smoke.json) |
| 成品 `--experience-smoke` | 18 项日常操作检查通过 | [回执](../../work/desktop-smoke/run-6WQhC1/desktop-smoke.json) |
| 成品内容核对 | 58 个运行文件与已测试源码一致，内置 Node 版本、二进制及许可证一致 | [核对记录](../../work/desktop-release-20261015/package-verification.json) |
| 快捷方式核对 | 指向本次成品，保留原参数和工作目录 | [核对记录](../../work/desktop-release-20261015/shortcut-verification.json) |

五组桌面场景均通过真实成品执行，使用独立测试工作区；界面、预加载桥接、普通浏览器访问限制及退出前草稿保存检查均通过。所有测试服务已停止，测试目录锁已释放。

主控目标场景实际作业启动为 0；聊天场景作业启动为 0，另运行一次固定 DSH 协议握手；任务操作、主控交付、日常操作场景分别运行 6、8、1 次固定本地程序。真实模型调用均为 0，这些检查验证成品流程，不代表模型输出质量验收。本次没有重跑独立的协作、求助和任务准备成品场景，也没有调用外部模型。

窗口检查覆盖 1040 × 700 外框和 100% / 125% / 150% 页面缩放，目标保存状态与重试入口可见。截图：[150% 目标恢复入口](../../work/desktop-smoke/run-6d08uk/managed-request-goal-error-150.png)、[小窗口聊天历史](../../work/desktop-smoke/run-5Sq02i/history-small-window.png)。

## 成品标识与备份

- 构建目录：`release/2026-10-15T07-48-01-406Z/CLI Team-win32-x64`。
- 前端资源：`index-DBqPPLKl.js`、`index-YRYka0gy.css`。
- `CLI Team.exe` SHA-256：`3e20fe6a2fb2a3eca01215ef293617295e19c786b73f571bf6568d04bf83e220`。
- 打包采用既有目录清单，成品中没有项目 `.team`、工作文件或测试工作区数据。
- 打包前的发布清单、快捷方式、说明文件和图标已备份到 `work/desktop-release-20261015/before/`，快捷方式工具另有独立备份。

完整机器记录见[发布验证汇总](../../work/desktop-release-20261015/validation-results.json)。
