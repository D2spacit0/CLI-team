<p align="center">
  <a href="#快速开始">
    <img src="docs/assets/banner.webp" alt="CLI Team - 把多个 CLI 组织成一支可验收的团队" width="100%">
  </a>
</p>

<p align="center">
  <strong>Windows 中文桌面工作台</strong> · 项目会话 · 多 CLI 接力 · 独立验收 · 固定成果版本
</p>

<p align="center">
  <a href="#快速开始"><img alt="下载 Windows 版" src="https://img.shields.io/badge/下载-Windows_x64-2563eb?style=for-the-badge&logo=windows11&logoColor=white"></a>
  <a href="#快速开始"><img alt="快速开始" src="https://img.shields.io/badge/快速开始-2_分钟-0f766e?style=for-the-badge"></a>
  <img alt="已发布版本 v0.1.0" src="https://img.shields.io/badge/已发布版本-v0.1.0-334155?style=for-the-badge">
  <img alt="数据保存在本地" src="https://img.shields.io/badge/数据-保存在本地-7c3aed?style=for-the-badge">
</p>

> 用一个目标调动多个官方 CLI。在同一项目中交代要求、查看团队接力、审阅完整成果；负责人安排派工与返工，程序保存版本和证据，最终发布由你确认。

当前源码包含 **2026-11-12 项目协作升级与科幻工作台改版**。深色指挥台把项目交接、负责人通讯和固定整稿放在同一工作面；GitHub 已发布的 `v0.1.0` 下载包尚未包含本轮变化。最新验证范围见[改版记录](docs/validation/2026-11-12-scifi-workbench.md)，底层协作与恢复规则见[业务升级记录](docs/validation/2026-11-12-team-upgrade.md)。

## 一张图看懂

<p align="center">
  <img src="docs/assets/scifi-workbench-20261112.png" alt="CLI Team 科幻工作台演练：项目索引、可定位的交接阶段、负责人通讯与固定整稿审阅" width="100%">
</p>

截图使用明确标注的演练数据。阶段数量来自项目工作记录，可点击定位具体交接；真实工作中的成员执行、程序收件与独立审稿分别留证。

## 本轮升级

| 参考项目 | 在 CLI Team 中落实的能力 |
| --- | --- |
| [solo-to-team-skills](https://github.com/dabingfy-dot/solo-to-team-skills/tree/bc9c19458e9d4afe42e506fc65673a68c26c6a56) | 派工登记执行人、收件人、跟进责任和原承诺；实际收件后再独立验收；失败和退回保持未完；新计划保留同一责任工作已用次数。 |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat/tree/e6567c7a681ce67869dce31486a21d3a25d6931b) | 项目、会话、执行活动和成果并排；折叠活动后仍显示阻碍；项目内搜索定位消息、交接与版本；借鉴持久作业、去重和恢复边界。 |

CLI Team 继续使用现有 Node、SQLite、React 和官方 CLI 执行层；本轮重新实现所需规则与交互，未整体迁入上游运行平台。内置协作规范有版本和摘要，随固定输入交给成员，不能增加执行权限。

项目工作从 `已派发 → 本机接纳 → 实际收件 → 独立验收` 推进。普通后继只在上游验收通过后启动；接收方必须核对相同代次的固定收件。计划退回会结束旧分工；快速暂停后继续、咨询失败重试和迟到结果都有明确处理。

## 使用项目工作台

1. 在成员设置中配置已登录的官方 CLI，选择负责人、执行成员和不同的独立审稿成员。能找到程序不代表模型调用已验证。
2. 打开“项目”并新建长期目标。首个业务模块面向一个小红书账号的图文生产，可以先准备内容再绑定账号。
3. 在负责人通讯区补充要求和反馈；点击顶部交接阶段定位工作，右侧查看资料、团队或整稿。切换稿件保留会话与输入草稿，搜索可定位历史版本。
4. 查看完整正文、有序配图、来源和独立审稿。需要修改时退回当前固定版本，团队生成新稿后重新核验。
5. 发布条件全部满足后，在桌面原生确认框批准这份稿件。账号、版本、图片顺序或发布时间范围改变后需重新批准；结果不确定时先核实。

负责人协调、接收核验、审稿和返工共用每日调用额度，默认最多 24 次；每项责任工作最多 3 次尝试。应用运行时推进有效项目，关机或关闭程序期间不会执行。模板图在本地生成真实 PNG，AI 生图尚未配置。真实平台发布仍需账号及连接器现场核验，详见升级验证记录。

## 你可以用它做什么

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>把目标交给团队</h3>
      <p>选择一个主控和 1–4 名成员，描述目标后由主控拆解依赖、派发任务、回收结果并处理返工。</p>
    </td>
    <td width="33%" valign="top">
      <h3>在同一个房间协作</h3>
      <p>支持 <code>@成员</code>、多人讨论、求助、改派和会话续接。每个成员保留自己的原生 CLI 会话。</p>
    </td>
    <td width="33%" valign="top">
      <h3>凭证据交付</h3>
      <p>绑定文件与哈希，运行显式检查，再交给独立评审。模型说“完成了”不能替代机器验收。</p>
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>失败后接着做</h3>
      <p>草稿、材料、分工和验收意见自动保存。暂停、重启或断线后可以恢复有效步骤，不盲目重放旧任务。</p>
    </td>
    <td width="33%" valign="top">
      <h3>数据留在本机</h3>
      <p>本地回环服务、SQLite 状态和任务目录。工作台不复制官方 CLI 的登录凭据，也不把任务数据混入发行包。</p>
    </td>
    <td width="33%" valign="top">
      <h3>从桌面或 CLI 操作</h3>
      <p>既能在独立窗口里工作，也能通过项目 CLI、MCP 和 skill 接入自己的主控流程。</p>
    </td>
  </tr>
</table>

## 交付不是一句话

<p align="center">
  <img src="docs/assets/scifi-delivery-20261112.png" alt="新版科幻工作台的本地交付演练：一次返工后，机器检查、独立评审和主控终审通过" width="100%">
</p>

图为本地确定性交付演练：测试成员实际执行，完成一次返工、机器检查、独立评审与主控终审。演练不调用真实模型。

```text
提交目标 → 主控拆解 → 成员执行 → 步骤审查
                              ↓
       交付 ← 主控终审 ← 独立评审 ← 机器检查
                              ↘
                          定向返工
```

任务只有在机器证据有效、产物版本未变化、独立评审和主控终审都通过时才自动交付。没有配置检查或缺少完整证据时，任务会停在待验收，交给用户确认。

## 快速开始

**下面的下载步骤适用于已发布的 `v0.1.0`，该包仍是旧界面。** 要使用上方新版界面，请展开本节下方的「从源码运行与打包」。

1. 从 [Releases](https://github.com/D2spacit0/CLI-team/releases/latest) 下载 `CLI-Team-v0.1.0-win32-x64-release.zip`。
2. 解压并保留整个 `CLI Team-win32-x64` 目录。
3. 运行 `CLI Team.exe`，在“工作区设置 → 主控与协作团队”中配置主控、成员和检查程序。
4. 安装并登录准备使用的官方 CLI，然后点击“交给主控”提交第一个目标。

桌面包已包含 Electron 和 Node.js 24，不需要另外安装 Node.js。程序目前未签名，Windows 可能显示 SmartScreen 提示。

<details>
<summary><strong>从源码运行与打包</strong></summary>

环境要求：Node.js 24+、Windows（用于桌面打包和桌面回归）。

```powershell
git clone https://github.com/D2spacit0/CLI-team.git
Set-Location CLI-team
npm ci
npm run build
npm start
```

生成 Windows 桌面程序：

```powershell
npm run dist:desktop
```

打包采用明确文件清单，不包含 `.team/`、`workspaces/`、`work/`、数据库、日志或官方 CLI 凭据。请保留完整程序目录，不能只移动 exe。

</details>

<details>
<summary><strong>支持哪些 CLI</strong></summary>

成员页面支持 Antigravity、DSH ACP、Claude Code、Gemini CLI、Codex CLI、OpenCode 和自定义适配器。

| 能力 | 说明 |
| --- | --- |
| 接入检测 | 只表示找到可执行入口，不代表已登录或真实模型调用成功 |
| 会话 | 同一成员可按房间续接自己的原生会话 |
| 模型 | 默认跟随官方客户端；也可在工作台明确选择 |
| 凭据 | 由官方客户端管理，工作台不复制登录 token |
| 自定义成员 | stdin 或 `{prompt}`、`{workspace}` 参数，返回约定 JSON |

DSH 还支持按房间续接、模型选择、取消执行，以及只读查看本机外部会话。只读挂载不会接管或重写原桌面会话。

</details>

<details>
<summary><strong>任务、材料与恢复</strong></summary>

**准备任务**

- 选择负责人、1–4 名成员和可选的独立评审者。
- 填写目标、完成标准、交付文件和可选材料。
- 可保存为待办；材料全部导入并核对后，再明确开始。
- 单文件最多 8 MiB，每任务最多 64 份、合计 32 MiB。

**执行与求助**

- 主控生成带依赖关系的步骤计划，服务校验成员权限和依赖后依次派发。
- 文件步骤可以约定相对路径与 `any`、`text` 或 `json` 格式。
- 分析步骤可以要求固定章节；缺文件、空文件、格式或章节不符都不能通过。
- 成员遇到具体问题时可以求助；负责人可只读答复，必要时咨询一名获授权成员。

**暂停、改派与恢复**

```powershell
node tools/team.mjs pause TASK_ID --note "调整分工后继续"
node tools/team.mjs progress TASK_ID
node tools/team.mjs assign TASK_ID --assignee OWNER_ID --members WORKER_A,WORKER_B --reviewer REVIEWER_ID
node tools/team.mjs start TASK_ID
```

暂停会等待成员进程和验收真正停止。改派保留文件、材料锁、历史记录和已用返工额度；只有用户明确继续后才重新规划。

**自动保存**

- 目标草稿、求助答复、返工意见和验收备注按任务与上下文保存。
- 断线或刷新后可以恢复，不会把草稿恢复成执行权限。
- 重试已送达的请求会找回原任务，不重复派工或通知。

</details>

<details>
<summary><strong>CLI 与 MCP 接入</strong></summary>

配置团队并提交目标：

```powershell
node tools/team.mjs configure-team --assignee OWNER_ID --members WORKER_A,WORKER_B --reviewer REVIEWER_ID --checks '["node","--test"]'
$goalRequestId = [guid]::NewGuid().ToString()
node tools/team.mjs submit --request-id $goalRequestId --objective "实现任务导出，支持按房间筛选，并交付测试与使用说明"
node tools/team.mjs progress TASK_ID
```

MCP 使用 stdio，示例配置：

```json
{
  "mcpServers": {
    "cli-team": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<仓库目录>\\tools\\mcp.mjs"]
    }
  }
}
```

常用 MCP 工具：`team_configure_controller`、`team_submit_objective`、`team_message`、`team_task`、`team_progress`、`team_answer_assistance`、`team_materials`、`team_evidence`、`team_decide`。

业务项目使用 `team_business_state`、`team_project_create`、`team_project_message`、`team_project_fact`、`team_project_material`、`team_content_preview`、`team_content_revision_request`。写入请求带稳定 `requestId`；主控提交的事实等待负责人采纳，素材保留主控来源；整稿通过固定版本分页读取。MCP 和 CLI 不提供发布批准。

```powershell
node tools/team.mjs business-state
node tools/team.mjs business-state PROJECT_ID --section work
node tools/team.mjs project-message PROJECT_ID --request-id REQUEST_ID --body "请补充来源与适用范围"
node tools/team.mjs content-preview CONTENT_ID --version VERSION_ID --section text
node tools/team.mjs content-revise CONTENT_ID --version VERSION_ID --request-id REQUEST_ID --feedback "配图与正文步骤需要统一"
```

项目 skill 位于 [`skills/cli-team-controller/SKILL.md`](skills/cli-team-controller/SKILL.md)，不会自动安装到全局技能目录。

</details>

<details>
<summary><strong>开发、检查与项目结构</strong></summary>

```powershell
npm test
npm run check
npm run build
npm run smoke:desktop
npm run smoke:desktop -- --packaged
```

| 目录 | 内容 |
| --- | --- |
| `desktop/` | Electron 主进程、桌面桥接与窗口测试 |
| `server/` | 调度器、适配器、API、权限、验收与持久化 |
| `ui/` | React 中文工作台 |
| `tools/` | 主控 CLI、MCP、打包与桌面检查 |
| `tests/` | 状态机、进程、接口、材料和桌面回归 |
| `.team/` | 本机运行数据与日志，不进版本控制 |
| `workspaces/` | 任务目录与真实交付产物，不进版本控制 |

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。确定性测试不调用付费模型；真实 CLI 验证单独进行。

</details>

## 安全边界

- 本地服务只绑定 `127.0.0.1`，并使用随机桌面令牌或本地主控凭据。
- 桌面渲染器启用沙箱，不提供 Node 权限；普通浏览器不能打开工作台。
- 默认不使用绕过审批的 CLI 参数，权限拒绝会阻止成功。
- 目录隔离和文件哈希不是操作系统沙箱。对不可信代码仍需额外隔离。
- 验收程序本身可以运行代码，必须由用户或主控明确选择。
- `.team/` 包含本地凭据、数据库和日志，不应提交或公开分享。
- 存在本地启动暂停标记时，桌面程序不会启动服务或执行成员任务。

## 已知限制

- 当前桌面发行包仅提供 Windows x64。
- Windows 成员进程树由 Job Object 监督器管理，首次使用需系统自带的 .NET Framework 编译器。缺失时会在启动成员前明确失败；不退回未经监督的执行。
- 旧版工作区升级前须停止原服务与排队任务。升级会生成数据库及工作文件快照，新版写入后旧版不能直接写同一数据库；恢复旧版应使用独立目录，不能覆盖升级后的工作区。
- 程序未进行代码签名，Windows 可能显示 SmartScreen 提示。
- 官方 CLI 需要自行安装、登录并承担相应额度。
- 当前 Codex 对话不会因为本地服务运行而全天候在线，也没有安装开机自启或定时唤醒。
- 模型结果和成员报告都视为未验证声明；验收依赖机器证据、独立评审和用户规则。

---

<p align="center">
  <sub>本地优先 · 证据驱动 · 中文桌面工作台</sub>
</p>
