# 前端视觉更新接入与成品验证

2026-10-13。接入本日下午更新的 `ui/workbench/tokens.css` 和 `ui/workbench/workbench.css`，成品构建时间为 15:29（Asia/Shanghai）。

## 本版变化

- 导航增加选中指示线、徽标和悬停反馈，房间列表调整图标底色、选中边框与间距。
- 聊天消息细化头像、角色标签、收件人标记、气泡边框和代码块样式。
- 成员选择改为圆角标签，输入框补充聚焦边框与光晕，发送错误和新消息提示更明确。
- 成员接力、任务状态、右侧检查面板和“待我处理”卡片统一使用颜色、圆角、阴影与过渡配置。

本次新交付集中在两个样式文件，组件和业务接口没有新增功能。先保存原始 UI 文件、桌面清单与快捷方式到 `work/frontend-refresh-20261013/before/`，随后完成接入检查。

审查发现两个未定义阴影变量影响四处样式：成员接力卡、结构化卡片和待处理卡的悬停阴影，以及新消息提示按钮阴影。已分别改用现有 `--wb-shadow-card-hover` 和 `--wb-shadow-popover`，保留本版视觉设计。修复后 CSS 引用检查没有发现缺少定义且无回退值的变量。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 268 通过，0 失败、跳过、取消、todo | [日志](../../work/frontend-refresh-20261013/npm-test.log) |
| `npm run check` | 通过 | [日志](../../work/frontend-refresh-20261013/npm-check.log) |
| `npm run build` | 通过 | [日志](../../work/frontend-refresh-20261013/npm-build.log) |
| CSS 变量引用检查 | 四处无效引用已修复，复核无缺失项 | [修复前](../../work/frontend-refresh-20261013/css-audit.json)、[修复后](../../work/frontend-refresh-20261013/css-audit-fixed.json) |
| 渲染探针 | 主动暂停文案、刷新/深链接恢复、七个预览场景与高缩放导航命中通过 | [收据](../../work/frontend-refresh-20261013/renderer-probe.json) |
| 成品 `--packaged --workbench-smoke` | 频道切换/恢复、草稿隔离、延迟回执、失败重试、消息去重、组合输入、历史位置和任务/日志侧栏通过 | [日志](../../work/frontend-refresh-20261013/packaged-workbench-smoke.log)、[收据](../../work/desktop-smoke/run-LyBZkA/desktop-smoke.json) |
| 成品 `--packaged --managed-smoke` | 团队配置、目标草稿、回执去重、逐项审查、返工、终审和交付通过 | [日志](../../work/frontend-refresh-20261013/packaged-managed-smoke.log)、[收据](../../work/desktop-smoke/run-LcQlMC/desktop-smoke.json) |
| 桌面打包与快捷方式更新 | 通过，入口目标与最新成品一致，原参数和工作目录保留 | [打包日志](../../work/frontend-refresh-20261013/package-desktop.log)、[快捷方式核验](../../work/frontend-refresh-20261013/shortcut-verification.json) |
| 源码及成品核验 | 验证期间 147 个源码文件未变化，46 个成品运行代码/资源文件逐字节一致 | [源码快照](../../work/frontend-refresh-20261013/source-tested.json)、[成品核验](../../work/frontend-refresh-20261013/package-verification.json) |

成品 `package.json` 单独按打包时移除 `private`、`scripts`、`devDependencies` 后的预期内容核对；`package-lock.json` 用于构建阶段的 `npm ci`，由 Electron Packager 默认过滤，不要求出现在成品中。

布局覆盖 1440×900 工作台和 1040×700 最小窗口，以及 100% / 125% / 150% Chromium 页面缩放。聊天区没有页面横向溢出，发送按钮可达；目标提交弹窗的主操作可见；导航滚动后可点击底部入口。没有改动 Windows 显示缩放。

桌面场景均使用独立测试数据，退出草稿握手通过，服务停止、工作区锁释放。聊天场景实际 CLI 启动为 0；主控场景运行 8 次固定协议程序，完成 1 次返工，真实模型调用为 0。这些结果验证流程和界面，不构成真实多模型协作质量验收。

## 成品与截图

直接打开项目根目录 [CLI Team 桌面端.lnk](../../CLI%20Team%20桌面端.lnk)，目标为：

[CLI Team.exe](../../release/2026-10-13T07-29-23-548Z/CLI%20Team-win32-x64/CLI%20Team.exe)。前端资源为 `index-DeKHtMXY.js` 和 `index-BxuRK3H_.css`。

![新版工作台，独立测试数据](../../work/desktop-smoke/run-LyBZkA/workbench-1440-1.png)

![150% 页面缩放下的目标提交弹窗](../../work/desktop-smoke/run-LcQlMC/managed-goal-150.png)
