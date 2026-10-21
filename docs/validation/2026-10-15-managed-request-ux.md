# 主控目标操作优化记录

2026-10-15，当前仓库，Node.js 24.12.0。完成目标输入、团队配置往返及故障恢复优化；仅更新源码与开发构建，未打包。

## 用户可见变化

- 草稿读取或保存失败时，可以在原窗口重试。关闭、稍后继续、进入团队设置会等待保存完成；处理中避免重复操作。
- 草稿恢复后光标进入目标输入。中文输入法按 Escape 取消选字不关闭窗口；正常 Escape 与关闭按钮遵守相同的保存规则。
- 配置成员后可以返回主控团队设置，再回到原频道的目标。团队保存成功后立即用于新目标，不依赖后续列表刷新成功。
- 首次提交前保存失败时，文字仍可修改。提交请求最多等待 15 秒；超时或回执丢失后保留原请求，重试核对同一任务。结果未明的旧请求不会因后续重试被拒绝而换成新请求。
- 任务创建回执已经收到时，即使列表刷新失败也能打开任务。提交后的草稿清理失败在任务详情中单独重试，不重新派工。
- 保存状态与草稿重试入口固定在目标窗口底部，长内容和高缩放下都能看到。

## 已执行验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 324 通过，0 失败、0 跳过、0 取消；426.34 秒 | [完整日志](../../work/managed-ux-20261015/npm-test-final.log) |
| `npm run check` | TypeScript 检查通过 | [日志](../../work/managed-ux-20261015/check-final.log) |
| `npm run build` | 开发构建通过 | [日志](../../work/managed-ux-20261015/build-final.log) |
| 托管任务与草稿定向测试 | 34 通过，0 失败、0 跳过 | [日志](../../work/managed-ux-20261015/targeted-first.log) |
| `--managed-request-smoke` | 新增 16 个目标操作场景全部通过 | [桌面回执](../../work/desktop-smoke/run-xt0pgt/desktop-smoke.json) |
| `--managed-smoke` | 8 次固定本地程序执行，1 次返工，机器检查及主控交付通过 | [桌面回执](../../work/desktop-smoke/run-Wj7m8r/desktop-smoke.json) |
| `--usability-smoke` | 原有任务准备、材料失败恢复、草稿往返和退出保护通过；11 次固定本地程序执行 | [桌面回执](../../work/desktop-smoke/run-5kEbxF/desktop-smoke.json) |
| `--experience-smoke` | 18 个日常操作场景全部通过；1 次固定本地文件程序执行 | [桌面回执](../../work/desktop-smoke/run-gbTWjQ/desktop-smoke.json) |

四组最终桌面场景都通过退出草稿保存握手，本地服务已停止，测试目录锁已释放。各场景使用独立目录，真实模型调用均为 0。新目标操作检查全程暂停调度：共创建 7 个测试任务、7 条排队作业，实际 CLI 启动数为 0；这些排队记录不代表执行或验收成功。

新增 16 个场景覆盖草稿读取重试、恢复后的焦点、保存失败时关闭及设置跳转、等待保存时连续操作、输入法 Escape、配置往返与原频道、团队保存后列表读取失败、提交前保存失败、明确拒绝后修正、提交期间关闭保护、丢失回执后刷新与团队变化、清理失败、创建成功后列表失败、15 秒提交超时，以及三档缩放。丢失回执场景还验证了后续一次 400 拒绝不会清除原请求编号。

## 窗口检查

窗口外框为 1040 × 700。通过实际 Electron 页面截图、视口尺寸和点击位置命中检查，确认底部状态、重试和提交区域可见且可操作。

| 缩放 | CSS 视口 | 底部可见 | 重试按钮未被遮挡 |
| --- | --- | --- | --- |
| 100% | 1024 × 661 | 是 | 是 |
| 125% | 819 × 529 | 是 | 是 |
| 150% | 683 × 441 | 是 | 是 |

截图：[150% 保存失败及固定重试入口](../../work/desktop-smoke/run-xt0pgt/managed-request-goal-error-150.png)、[返回原目标](../../work/desktop-smoke/run-xt0pgt/managed-request-returned-goal.png)、[任务内单独清理草稿](../../work/desktop-smoke/run-xt0pgt/managed-request-cleanup-recovery.png)。[窗口测量](../../work/desktop-smoke/run-xt0pgt/managed-request-layouts.json)单独保存。

## 复现与修正记录

修改前的[初次复现回执](../../work/desktop-smoke/run-UvOeEg/desktop-smoke.json)保留了失败截图。该次超时探针没有等待请求实际发出，属于检查脚本时序问题，未计为产品缺陷；之后改为等待请求出现，再核对超时与同编号重试。其他失败用于定位上述用户操作缺口。

固定底部恢复入口之前的首轮 16 项通过记录保留在 [run-LnshkP](../../work/desktop-smoke/run-LnshkP/desktop-smoke.json)。随后根据 150% 截图补充了按钮点击位置检查，并重新通过全部 16 项。

原有托管回归首次在点击“稍后继续”后立即检查退出，而新的关闭流程当时仍在等待保存，因而被正确阻止。保留[失败回执](../../work/desktop-smoke/run-wUAJKP/desktop-smoke.json)及截图；脚本改为等待弹窗真正关闭后，再执行原有的退出保存断言，随后全流程通过。没有移除退出、去重或交付检查。

## 发布与范围

当前开发资源为 `dist/assets/index-DBqPPLKl.js` 与 `dist/assets/index-YRYka0gy.css`。没有运行 `package:desktop` 或 `dist:desktop`，现有桌面快捷方式仍打开此前的成品；使用 `npm start` 查看本轮开发版。

| 发布入口 | 优化前后 SHA-256 |
| --- | --- |
| `release/latest-desktop.json` | `5E46B59FBBDF06266171FEA32BFA440932A39E59B5AD5C6BBECA9DF5C2B53775` |
| `CLI Team 桌面端.lnk` | `DA3F0A7AAC1B0A33937BBE0F5A7EE2F9998D182CC550BE76AF0AA103F1067A61` |

此次没有连接真实模型验证模型输出质量，也没有执行成品回归。服务事务去重、机器验收规则及官方 CLI 凭据管理没有变更。[验证汇总](../../work/managed-ux-20261015/validation-results.json)和修改前源码备份保留在项目内，[设计记录](../plans/2026-10-15-managed-request-ux.md)说明实现选择。
