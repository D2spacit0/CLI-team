# 桌面快捷方式旧版入口修复

2026-10-13。在当前会话接续用户反馈的“看起来没变化”，发现项目根目录 `CLI Team 桌面端.lnk` 仍指向 10 月 9 日的程序。没有确认用户上次使用的具体入口；已确认从这个快捷方式启动会进入旧版。

## 已核实的原因

- 原目标：`release/2026-10-09T02-39-07-960Z/CLI Team-win32-x64/CLI Team.exe`。
- 10 月 13 日上午的新包已包含 Gemini 工作台，JS/CSS 与当前构建逐文件 SHA-256 一致，但打包只更新了 `latest-desktop.json`，没有更新旧快捷方式。
- 原入口的工作目录与保存的工作区均为本地项目目录。

## 修复

- `tools/package-desktop.mjs` 在新包生成后调用 Electron 原生快捷方式 API，更新项目根目录入口；更新失败会使打包命令明确失败。
- `tools/update-desktop-shortcut.mjs` 核验目标位于当前项目的 `release` 内，拒绝覆盖指向自定义程序的快捷方式，更新前保存旧文件，并读回确认目标。
- 旧启动参数、工作目录、窗口模式和快捷键均已核对保持一致。备份及核验收据写入 `work/desktop-shortcuts/`。
- 使用说明改为从根目录快捷方式进入。更新器不创建窗口、不启动业务服务，不改动项目外的快捷方式。

首次打包的快捷方式步骤因 Electron ESM 入口顶层等待 `app.whenReady()` 而超时；已改成异步函数调用，完成独立复测和完整重新打包。失败日志保留，交付以第二次打包为准。

当前成品：[CLI Team.exe](../../release/2026-10-13T05-12-05-529Z/CLI%20Team-win32-x64/CLI%20Team.exe)，构建时间 2026-10-13 13:12（Asia/Shanghai）。根目录快捷方式已指向此程序。

## 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 268 通过；0 失败、跳过、取消、todo | [日志](../../work/desktop-entry-fix-20261013/npm-test.log) |
| `npm run check` | 通过 | [日志](../../work/desktop-entry-fix-20261013/npm-check.log) |
| `npm run build` | 通过 | [日志](../../work/desktop-entry-fix-20261013/npm-build.log) |
| 两个构建工具的 `node --check` | 通过 | 执行后继续打包 |
| 完整桌面打包及入口更新 | 通过；原生 API 保存、读回成功 | [最终打包日志](../../work/desktop-entry-fix-20261013/package-desktop-retry.log)、[入口收据](../../work/desktop-shortcuts/update-FyO9WI/receipt.json) |
| 独立 Windows 快捷方式与成品文件核验 | 目标等于最新清单；启动选项保留；工具与前端成品哈希一致 | [核验记录](../../work/desktop-entry-fix-20261013/entry-verification.json) |
| 成品 `--workbench-smoke` | 通过；频道切换与刷新、草稿隔离、延迟回执、发送失败、消息去重、组合输入、历史阅读、任务/日志侧栏 | [日志](../../work/desktop-entry-fix-20261013/packaged-workbench-smoke.log)、[收据](../../work/desktop-smoke/run-5RSHDi/desktop-smoke.json) |
| 窗口布局 | 1440 与 1040 窗口、100% / 125% / 150% 页面缩放均无横向溢出，发送区可见 | 同上收据中的 `layouts` |

成品工作台的稳定截图中，可以看到紧凑蓝色导航、待我处理、交给主控、聊天室搜索和右侧检查面板：

![新版工作台，独立测试数据](../../work/desktop-smoke/run-5RSHDi/workbench-1440-1.png)

该回归使用独立测试数据，实际 CLI 启动和真实模型调用均为 0；退出保存握手通过，服务已退出，工作区锁已释放。没有把固定数据回归表述为真实模型协作验收。

旧、新包的基础启动对比也完成了资源哈希核对和服务退出检查，见 [comparison.json](../../work/desktop-entry-fix-20261013/comparison.json)。其默认启动截图没有等待 React 完成挂载，新版截图捕获为空白，因此不用于视觉验收；视觉结论来自上述完整工作台回归的稳定画面。

本轮未修改 Gemini 的界面设计或业务接口。源文件及原快捷方式备份位于 `work/desktop-entry-fix-20261013/before/`。
