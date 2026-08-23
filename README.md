# OpenClaw Model Switcher v6.5.2 — Portable Edition

**OpenClaw 一站式管理面板**：Agent / 模型 / 供应商 / 飞书 Bot / 工作区 / openclaw 本体维护。
零依赖 Web UI（本地 Vue 打包，无 CDN），直接读写 `openclaw.json`（原子写入 + 自动备份），
跨平台（Windows / macOS / Linux），路径全自动检测。

## ✨ 功能总览

### 🤖 Agent 管理
- **新建**：可选 18 个内置模板（全能专家/总助秘书/编程助手/…中文标签），可指定工作区（留空 = openclaw 默认工作区布局）
- **编辑**：显示名 / 默认模型 / 设为默认标记 / **工作区变更**（自动迁移目录，含父目录与冲突保护）
- **重命名 ID**：一键迁移全部关联 —— 工作区目录、agents 目录（含会话）、配置字段、路由绑定、飞书账号键、场景配置；默认 agent 受保护
- **删除**：默认 agent 不可删除（需先转移默认标记）；删除同步清理飞书账号、绑定与场景死键
- **默认 agent 实时解析**：第一个 `default:true` → 无则 list 第一个 → 才轮到 `main`，整行红色高亮；切换默认标记自动冻结原默认工作区，防止解析跳变
- **模板切换**（慎用）：覆盖 AGENTS.md/SOUL.md/TOOLS.md/… 并重置记忆

### 🔄 模型切换
- 每 Agent 独立下拉（按供应商分组，支持搜索过滤），批量设置 + 批量应用
- 默认模型注册表自动同步；`prune` 一键清理孤儿模型键（支持 dry-run 预览）

### ⚙️ 供应商配置
- 已配置供应商表 + 添加/验证（probe 实时探测模型列表）
- 自定义供应商（ID/BaseURL/APIKey/协议/Auth Header），中文 ID 支持
- 全部刷新并发执行（6 路），失败互不阻塞

### 🐦 飞书 Bot 管理
- Bot 账号（appId/appSecret/白名单 allowFrom）按 Agent 卡片展示
- 路由绑定（channel=feishu → accountId → agentId）、扫码注册向导、连接诊断

### 💾 数据安全
- 所有写操作串行化（写锁）+ **原子写入**（临时文件 rename）+ 自动备份（保留 100 份，去抖 3s）
- 手动备份 / 回滚（回滚前自动备份当前状态，误操作可再滚回）
- 场景预设（保存/加载/删除，覆盖需确认）

### 📁 文件浏览器
- 按 Agent 浏览工作区，单层 400 项上限防卡死（超大目录截断提示），在线查看/编辑文件

### ⬆️ openclaw 本体维护
- **版本检查与更新**：npm 最新版 + 历史版本（含 beta）下拉，安装/更新即点即用（输出实时回显）
- **安装向导**（新机器部署）：
  - 前置环境检测（Node 22.22.3+/24.15+/25.9+、npm、winget 一键装 Node LTS）
  - 可选**安装位置**（npm 全局 prefix，自动处理含空格路径）
  - 可选**数据根目录**（自动生成 `.openclaw/` 状态根 + `workspace/`，设置 `OPENCLAW_HOME` 用户环境变量）

### 🛡 安全设计
- 路径白名单（打开文件夹）、路径穿越防护（模板名/文件路径/备份路径全校验）
- 密钥脱敏显示（只显示头尾）、可选 Bearer Token 认证（静态资源自动放行）
- 静态资源仅 index.html + vue.global.prod.js，其余一律 404；`no-store` 无缓存

## ⚡ 快速开始

### 从 GitHub 下载（Windows）

1. **Code ▾ → Download ZIP** 解压（或 `git clone`）
2. **先装 Node.js 18+**：https://nodejs.org/
3. 双击 **`一键部署.bat`**：
   - 自动检测 Node/npm/openclaw/端口占用，目录无 `.tgz` 时自动 `npm pack`
   - 三种安装模式：全局（推荐）/ 本地 / 自定义 prefix
   - 安装后自动跑内置冒烟测试（自包含），然后自动启动面板
4. 浏览器打开 http://localhost:2325/

### 手动运行

```bash
node switcher.cjs          # 或双击 启动Switcher.bat（Windows）/ ./启动Switcher.sh（macOS/Linux）
```

### 本机默认布局（自动检测）

```
OPENCLAW_HOME  =  <盘>:\openclaw\.openclaw     # 配置/状态根
OPENCLAW_WS    =  <盘>:\openclaw\workspace     # 工作区
OPENCLAW_CLI   =  <npm 全局>\node_modules\openclaw\openclaw.mjs
PORT           =  2325
```

> 提示：面板是 openclaw 的**管理界面**，openclaw 本体需另行安装
> （`npm install -g openclaw`）。未装时大部分功能可用，仅 `/api/models`
> 与飞书诊断提示 "CLI not configured"；也可以直接用面板右上角
> 「🛠 安装 openclaw」向导完成。

## 🔧 环境变量

| 变量 | 作用 | 示例 |
|------|------|------|
| `OPENCLAW_HOME`   | `.openclaw` 状态根目录 | `C:\Users\me\.openclaw` |
| `OPENCLAW_WS`     | 工作区根目录 | `D:\work\workspace` |
| `OPENCLAW_AGENTS` | agents 目录 | `C:\...\agents` |
| `OPENCLAW_CLI`    | `openclaw.mjs` / `dist/index.js` 路径 | `C:\…\npm\node_modules\openclaw\openclaw.mjs` |
| `FEISHU_REG`      | `app-registration-*.js`（自动检测） | 一般无需设置 |
| `OPENCLAW_NODE`   | node 可执行文件 | `<node 安装目录>\node.exe` |
| `SWITCHER_PORT`   | 端口（默认 2325，占用自动 +1） | `2400` |
| `SWITCHER_LOG`    | 日志文件路径 | 默认 `%LOCALAPPDATA%\OpenClawModelSwitcher\` |
| `SWITCHER_BACKUP_DIR` | 备份目录（建议每实例独立） | 同上 |
| `SWITCHER_SCENES` | scenes.json 路径 | 同上 |
| `SWITCHER_TOKEN`  | 设置后启用 Bearer Token 认证 | `my-secret` |

**路径自动检测顺序**：显式环境变量 → 平台约定（Windows `<盘>:\openclaw\...`）→ OS 默认
（Linux/macOS `~/.openclaw`）→ npm 全局 → `where/which` → 有界父目录扫描。

## 🧩 Agent 模板机制

**模板查找顺序**：
1. `<switcher 安装目录>/templates/<模板名>` —— 内置推荐模板
2. `OPENCLAW_WS/_templates/<模板名>` —— 自定义集中目录
3. 现存 Agent 的 workspace —— 现有 agent 可当模板
4. `OPENCLAW_WS/<模板名>` —— 兜底

创建时复制 `AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md / HEARTBEAT.md / BOOTSTRAP.md`；
`MEMORY.md` **不复制**（新 agent 从空记忆开始）。

**内置推荐模板（18 个）**：

| 模板 | 用途 | 模板 | 用途 |
|------|------|------|------|
| `all-rounder` | 全能专家 | `research` | 调研分析师 |
| `ceo-assistant` | 总助秘书 | `seo` | SEO 优化师 |
| `coding` | 编程开发助手 | `social-media` | 社媒运营 |
| `data-analyst` | 数据分析师 | `support` | 客服专家 |
| `design` | 设计顾问 | `teacher` | 教育辅导 |
| `ecommerce` | 电商运营 | `translator` | 专业翻译 |
| `finance` | 财务分析 | `video` | 视频编导 |
| `health` | 健康顾问 | `wechat` | 深度内容编辑 |
| `law` | 法律助手 | `xhs` | 小红书笔记操盘手 |

自定义模板：在 `OPENCLAW_WS/_templates/` 下建目录放入上述 .md 文件即可，前端下拉自动出现。

## 📡 API 一览

无需 CLI（面板核心）：

```
GET  /api/status                     # 状态/统计/默认工作区
GET  /api/agents                     # agent 列表（含默认标记实时解析）
GET  /api/providers                  # 供应商
GET  /api/providers/catalog          # 供应商目录（含模型）
GET  /api/providers/available        # 可用供应商（30s 缓存）
GET  /api/backups?all=1              # 备份（all=1 全量）
GET  /api/scenes /api/log?lines=N    # 场景 / 日志
GET  /api/feishu /api/feishu/diagnostics
POST /api/switch                     # {changes:{agentId:modelId}}
POST /api/probe                      # {provider, apiKey, baseUrl?}
POST /api/providers/update|delete|refresh-all
POST /api/backup /api/rollback       # {path}
POST /api/agent/create               # {id, workspaceTemplate?, workspace?}
POST /api/agent/update               # {id, name?, model?, default?, workspace?}
POST /api/agent/rename               # {id, newId} 全关联迁移
POST /api/agent/delete               # {id}
POST /api/agent/template/apply       # {id, template?}
POST /api/agent/tools/toggle         # {id, tool, deny}
POST /api/agents/defaults/workspace  # {workspace?} 变更默认工作区；空=恢复内置默认
GET  /api/agent/:id/files|file       # 文件浏览/读取
POST /api/agent/:id/file/write
POST /api/scenes/save|apply|delete
POST /api/feishu/bot/save|delete
POST /api/feishu/binding/save|delete
POST /api/feishu/allowfrom/add|remove
```

需要 CLI（未装返回 503）：

```
GET  /api/models?q=...
POST /api/feishu/register/begin|poll|save     # 扫码注册向导
```

openclaw 本体维护：

```
GET  /api/openclaw/update/info        # 当前/最新/历史版本（30s 缓存）
POST /api/openclaw/update             # {version?} 空=最新
GET  /api/openclaw/install/status     # 前置环境检测（30s 缓存）
POST /api/openclaw/install            # {prefix?, root?}
POST /api/openclaw/install/node       # winget 一键装 Node LTS
```

## 📦 文件说明

| 文件 | 用途 |
|------|------|
| `switcher.cjs` | Node.js 服务器（便携单文件） |
| `index.html` | 单页前端（Vue 3，本地打包） |
| `vue.global.prod.js` | 本地 Vue 运行时（无 CDN） |
| `templates/` | 18 个内置 agent 模板 |
| `一键部署.bat` | Windows 一键安装/部署 |
| `启动Switcher.bat` / `启动Switcher.sh` | 启动脚本 |
| `install-task.ps1` | 注册开机自启计划任务 |
| `test/smoke.js` | 自包含冒烟测试（`node test/smoke.js`） |
| `scenes.json.example` | 场景配置文件示例 |
| `scripts/write-shasums.js` | 重新生成 SHA256SUMS |

运行时数据默认在 `%LOCALAPPDATA%\OpenClawModelSwitcher\`（Windows）
或 `~/.openclaw-model-switcher/`（Linux/macOS）：`backups/`（100 份）、`switcher.log`、`scenes.json`。

## 🚀 开机自启（Windows）

右键 `install-task.ps1` → 使用 PowerShell 运行（管理员），
注册 `OpenClawModelSwitcher` 计划任务：登录自启 + 崩溃自动重启。

## 🖥 多实例

同一台机器跑多个面板：不同端口 + 各自独立的
`SWITCHER_LOG` / `SWITCHER_BACKUP_DIR` / `SWITCHER_SCENES` / `OPENCLAW_HOME`
（否则备份会互相覆盖）。

## 🔍 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 浏览器连不上，日志显示 Port in use | 端口被占 | `SWITCHER_PORT=2326` 或自动 +1 |
| `/api/status` → Config read failed | `OPENCLAW_HOME` 无 openclaw.json | 不设环境变量，看启动日志 `home=` |
| `/api/models` → 503 CLI not configured | 没装 openclaw / 找不到 CLI | 装 openclaw 或设 `OPENCLAW_CLI` |
| 飞书注册 503 | FEISHU_REG 缺失 | 安装带飞书集成的 openclaw |
| 黑窗闪退 | node 不在 PATH | 装 Node 或设 `OPENCLAW_NODE` |
| 改名/迁移后 gateway 行为异常 | gateway 缓存旧 id | 重启 openclaw gateway |
| 部署后 UI 没变化 | 浏览器缓存 | 已改为 no-store，正常刷新即可 |

## ✅ 冒烟测试

```bash
node test/smoke.js    # 临时隔离实例，退出码 0 = 通过
```
