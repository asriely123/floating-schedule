# 悬浮课表 FloatingSchedule

一个 Windows 桌面的悬浮课程表小工具：淡蓝半透明「桌面挂件」，常驻桌面底层——**只在桌面之上、其他一切窗口之下**；点一下可临时前置编辑，失焦后自动落回。绿色免安装单文件 exe，双击即用，界面全中文。

## 功能特性

- 课表网格：周一 ~ 周五 × 每天 4–14 节课；双击或聚焦后按 Enter/空格编辑，Shift+Enter 换行
- 每节课起止时间逐条自定义（设置面板，支持增删节次）
- 课表按周翻页（总周数可设 1–30），**每周内容独立**；一键「复制上周」
- 记住上次查看的周，重启自动恢复（首次使用时定位当前周）
- 按「开学日期」（第一周周一）计算当前周；「回本周」一键跳转
- 当前查看周为本周时，当前星期整列高亮、正在上的课实底高亮（30 秒自动刷新，下课自动恢复）
- 窗口可拖动、可缩放，位置与大小自动记忆；托盘「恢复默认位置」救援入口（拖丢了也能找回来）
- 系统托盘图标：左键切换显示/隐藏；右键菜单（显示/隐藏、恢复默认位置、退出）
- 开机自启开关（设置面板内）
- 数据优先存于程序同目录 `schedule.json`，自动备份 `schedule.bak`；主文件损坏时从备份恢复，目录不可写时回退到用户数据目录

## 快速开始

### 直接使用（推荐）

双击 `dist\FloatingSchedule-0.1.0-portable.exe` —— 绿色便携版，无需安装、无写入系统目录。exe 未签名，个别杀毒软件可能误报，放行即可。

### 开发模式

要求 Node.js 18+：

```bash
npm install
npm start
```

若 Electron 二进制下载失败（网络原因），改用镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

### 测试

```bash
npm test
```

正式回归使用系统临时目录隔离数据，带超时控制；任一断言失败或超时均以非零退出码结束，不会覆盖个人课表。源码中的 `SCHEDULE_*` 测试钩子仅在 `SCHEDULE_TEST_MODE=1` 时启用；真实开机自启探测另行保护并恢复原状态。

## 打包

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist
```

产物：`dist\FloatingSchedule-<版本>-portable.exe`（当前 v0.1.0，约 95MB）。

## 数据说明

`schedule.json`（优先在 exe 同目录）结构：

| 字段 | 含义 |
|---|---|
| `settings` | 每天课数、节次时间表、总周数、开学日期、窗口不透明度、开机自启 |
| `window` | 窗口位置与大小（越界启动时自动回右下角） |
| `viewWeek` | 上次查看的周 |
| `weeks` | 各周课表内容（周 → 星期 0=周一至4=周五 → 节次 → 课程名） |

文件缺失、损坏或字段异常时自动归一化；主文件不可读时优先从 `.bak` 恢复，不会崩溃。

## 目录结构

```
├─ src\            # 应用源码（main.js 主进程 / preload.js / renderer 界面）
├─ assets\         # 图标（托盘/应用/.ico，由 scripts\make-icon.js 生成）
├─ scripts\        # 图标生成、测试数据重置、koffi 可用性检查
├─ docs\           # 需求 / 技术方案 / 设计规范 / 执行步骤（标准文档）
├─ 开发日志\        # 分阶段开发记录（完成事项 / 待办事项）
├─ dist\           # 打包产物（便携版单 exe）
└─ AGENTS.md       # AI 代理开发的工作指引
```

## 技术栈

Electron 44 + 原生 HTML/CSS/JS（零框架、零打包器）+ koffi（调用 Win32 实现窗口置底），开发依赖仅 electron-builder。应用无任何运行时网络请求。

## 开发方式：Vibe Coding

本项目**全程由 AI 编码代理通过 vibe coding 方式开发**：需求逐项确认 → 建立标准文档 → 分五个阶段实现（每阶段结束自动化 E2E 验收 + 人工验收，验收通过才进入下一阶段）→ 打包交付。开发过程完整留痕：

- `docs\01-需求文档.md` ~ `04-执行步骤.md`——需求、技术方案、设计规范、分阶段计划与验收清单
- `开发日志\`——每个阶段的完成事项、验证结果、待办事项（含各类环境坑的记录）
- `AGENTS.md`——代理开发的工作指引（文档索引、工作流程、代码规约）
- 源码内置开发自检钩子（`SCHEDULE_SHOT` / `SCHEDULE_E2E` 等 `SCHEDULE_*` 环境变量），仅在 `SCHEDULE_TEST_MODE=1` 时启用；正式回归入口为 `npm test`

## 已知说明

- 目标环境 Windows 11（22H2+），实测 DPI 150% 正常
- 半透明实现为「透明窗口 + CSS 自绘卡片」：Electron 的 Acrylic 系统磨砂材质在该环境下实测不生效（排查过程见开发日志与 `docs\02`）
- 开机自启应只在打包版验收：开发模式确实会向 Windows 登记 `electron.exe`，但该可执行文件不携带本项目启动参数，登录后不能可靠地启动本应用。
