# PortBoard · 本地服务

一个零外部依赖的跨平台本地服务与端口管理看板：**扫描本机监听端口 → 手工添加 / Agent 上报 → 周期探活与资源监控 → 启停与日志查看**，把「本机到底跑着哪些服务、占了多少内存/CPU、多久没用过」收敛成一张清爽可查的表。

---

## 为什么做这个工具

- 会话级后台任务工具只管当前进程/会话内的子任务，窗口一关或换个对话就失联；
- 手动在终端拉起的 Python / Node / Go 服务、同步工具、开发看板，时间一长全靠 `netstat` / `lsof` 猜谁该关；
- PortBoard 把这些服务统一落到本机私有 JSON 注册表，同时提供稳定的 HTTP / CLI 接口给任意 AI Agent 自动上报。

---

## 核心特性

- **零依赖、免构建**：仅使用 Node.js 内置模块（兼容 **Node.js ≥ 14.16** 至 22+），`node server.js` 即是全部。
- **跨平台端口发现**：支持 Windows（`netstat` + `tasklist`）、macOS（`lsof`）、Linux（`ss`），多地址监听自动聚合，高亮对外暴露端口（`0.0.0.0` / `*` / `::`），支持**忽略端口名单**与一键恢复。
- **三态探活与闲置清理**：自动维护 `运行中` / `已停止` / `未运行` 状态及最近活跃时间，提供 **「仅看闲置 ≥ 30 天」** 快捷筛选视图。
- **资源实时监控与可调周期**：按唯一 PID 采集运行中服务的 **内存占用** 与 **实时 CPU%**（Windows 走 `Get-Process`，macOS/Linux 走 `ps`），界面支持随时切换采样周期（`5s` / `15s` / `60s` / `手动`）。
- **安全启停与进程指纹防误杀**：
  - 自身端口保护（UI 按钮置灰 + 后端拦截）、`< 1024` 系统端口保护、关键系统进程白名单、服务名确认；
  - 支持可选 `stopCommand` 优雅停止（超时回退至进程树结束）；
  - **进程命令行指纹校验**：自动捕获或手动指定进程指纹，端口被其他不相关进程占用时自动标黄告警并阻止误杀。
- **环境变量与双源日志**：支持按行配置 `KEY=VALUE` 环境变量；PortBoard 托管启动的服务自动记录输出日志（超过 512KB 自动轮转），也支持填写外部 `logFile` 路径直接查看日志。
- **现代交互体验**：
  - 4 套内置配色主题（极简纯白 / 暖米纸感 / 经典蓝白 / 中性石墨），右上角 4 枚色点一键切换；
  - 扫描 / 详情 / 最近动态统一采用右侧抽屉，主表零遮挡；
  - SSE 实时同步（断线自动降级为轮询模式）；
  - 支持批量检查/停止/删除、配置导出/导入（剥离本机运行时字段）、`Esc` 关闭抽屉、`/` 快速搜索与一键复制。

---

## 快速开始

### 方式一：双击启动脚本（推荐）

脚本会自动检测 `127.0.0.1:8888` 是否已在运行——**已运行则直接打开浏览器，未运行则启动服务并打开页面**，防止重复拉起：

| 平台 | 脚本 |
|---|---|
| Windows | `start.cmd` |
| macOS | `start.command`（首次需 `chmod +x start.command`） |
| Linux | `start.sh`（首次需 `chmod +x start.sh`） |

### 方式二：命令行启动

```bash
# 需要 Node.js >= 14.16
node server.js
# 浏览器打开 http://127.0.0.1:8888
```

```bash
npm start          # 启动服务
npm test           # 运行单元测试与集成测试
node cli.js scan   # 命令行扫描监听端口
node cli.js list   # 命令行查看已登记服务
```

### 状态存储位置

状态文件与托管日志默认落在本机私有目录，不进入代码仓库与同步树：

| 平台 | 默认路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\dsh\port-board\registry.json` |
| macOS / Linux | `~/dsh/port-board/registry.json` |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORTBOARD_PORT` | `8888` | 监听端口（仅绑定 `127.0.0.1`） |
| `PORTBOARD_TOKEN` | 空 | 设置后所有写操作与事件流需携带 `x-portboard-token` |
| `PORTBOARD_HOME` | 见上表 | 状态与托管日志根目录 |
| `PORTBOARD_SWEEP_MS` | `60000` | 初始自动探活与资源采样周期（ms）；`0` 为手动，界面调整后持久覆盖 |
| `PORTBOARD_ALLOW_SYSTEM` | 空 | 设为 `1` 允许操作 `< 1024` 系统端口 |

---

## Agent 上报与 CLI

### HTTP 上报（幂等 Upsert）

```http
POST /api/report
Content-Type: application/json
x-portboard-token: <可选>

{
  "name": "本地看板",
  "port": 3000,
  "url": "http://127.0.0.1:3000",
  "command": "python run_dashboard.py",
  "cwd": "/path/to/dashboard",
  "note": "临时预览看板",
  "owner": "agent-session",
  "status": "running",
  "pid": 12345
}
```

### CLI 常用命令

```bash
node cli.js report --name "本地看板" --port 3000 --url http://127.0.0.1:3000 --command "python run_dashboard.py"
node cli.js report --name "本地看板" --port 3000 --status stopped
node cli.js list [--json]
node cli.js scan [--json]
node cli.js check "本地看板"
node cli.js logs "本地看板" [--lines 150]
node cli.js start "本地看板"
node cli.js stop "本地看板" --yes
node cli.js restart "本地看板" --yes
node cli.js rm "本地看板"
```

### 给 Agent 的接入片段（可放进 `AGENTS.md`）

```md
## 本地服务登记
启动常驻监听服务后上报至 PortBoard：
  node <path-to-port-board>/cli.js report --name "<服务名>" --port <端口> --cwd "<工作目录>" --command "<启动命令>"
关闭服务后：
  node <path-to-port-board>/cli.js report --name "<服务名>" --port <端口> --status stopped
```

---

## HTTP API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/state` | 全量状态、汇总、资源占用、忽略端口、采样设置与最近动态 |
| `GET` | `/api/events` | SSE 实时事件流（`ready` / `state` / `scan`） |
| `POST` | `/api/settings` | 更新采样周期（`{ sweepMs }`） |
| `POST` | `/api/scan` | 扫描本机监听端口 |
| `POST` | `/api/scan/ignore` | 忽略指定端口（`{ port }`） |
| `DELETE` | `/api/scan/ignore/:port` | 恢复已忽略端口 |
| `POST` | `/api/entries` | 手工添加服务（同端口去重） |
| `PATCH` | `/api/entries/:id` | 修改服务配置并立即探活 |
| `DELETE` | `/api/entries/:id` | 仅删除登记记录，不停止进程 |
| `GET` | `/api/entries/:id/logs` | 读取托管日志或外部 `logFile`（`?lines=150`） |
| `POST` | `/api/entries/:id/check` | 立即探活 |
| `POST` | `/api/entries/:id/start` | 启动服务（支持 `env` 注入与日志重定向） |
| `POST` | `/api/entries/:id/stop` | 停止服务（校验 `confirm` 与进程指纹，优先 `stopCommand`） |
| `POST` | `/api/entries/:id/restart` | 重启服务 |
| `POST` | `/api/report` | Agent 幂等上报 |
| `GET` | `/api/export` | 导出纯净服务清单（不含运行时字段） |
| `POST` | `/api/import` | 导入并合并服务清单 |

> `:id` 路径参数同时接受条目 `id` 或服务名称。

---

## 目录结构

```text
port-board/
├── server.js               # HTTP 服务、状态机、探活/资源采样、SSE 与启停控制
├── cli.js                  # 命令行客户端
├── lib/
│   └── scan.js             # 跨平台端口、资源与命令行指纹采集解析
├── public/
│   └── index.html          # 原生单页 UI（4 主题、抽屉、批量操作、快捷键）
├── test/
│   └── port-board.test.js  # 单元测试与服务端集成测试
├── start.cmd               # Windows 防双开启动脚本
├── start.command           # macOS 防双开启动脚本
├── start.sh                # Linux 防双开启动脚本
├── package.json
└── README.md
```

---

## 排错与已知边界

- **只绑定 `127.0.0.1`**：面向本机单用户设计，不对外网暴露；`PORTBOARD_TOKEN` 用于防止本机其他脚本误写。
- **macOS / Linux 权限边界**：`lsof` 与 `ps` 仅能读取当前用户权限可见的进程，系统级守护进程可能无法采集。
- **Windows 沙箱说明**：子进程采集统一走临时文件重定向而非管道，规避受限环境 `EPERM`；若权限不足无法停止高权限进程，需以管理员身份运行。
- **定位说明**：PortBoard 是轻量的本地服务登记与操作台，不替代 PM2 / systemd 做开机自启与崩溃拉起。
