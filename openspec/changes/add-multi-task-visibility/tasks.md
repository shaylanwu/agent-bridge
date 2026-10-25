# 实施清单：add-multi-task-visibility

> 分批实施：批次 A（幂等 + 容量水位）本轮完成并过门禁；批次 B（步骤流）、C（双表面面板）后续跟进。

## 1. 提案与规格

- [x] 1.1 建 `proposal.md` / `tasks.md` / specs 增量（bridge-protocol 两条 ADDED，task-execution 一条 ADDED）
- [x] 1.2 澄清结论落档：`task_step` 系全新消息（平台需实现消费端）；步骤为动态步骤流，无预定义总步数

## 2. A1：任务幂等

- [x] 2.1 `TaskSupervisor` 按 `taskId` 去重（byId 有界 LRU）：未终态回当前状态快照，已终态回放终态，不重复 spawn
- [x] 2.2 单测：重复 taskId 不重复 spawn；运行中重发回当前状态；终态后重发放终态快照

## 3. A2：容量水位

- [x] 3.1 `protocol.ts`：`hello.capacity` + `capacity_update` 消息 + `capabilities` 加 `capacity`
- [x] 3.2 `TaskSupervisor` 状态变化观察者（subscribe）；session 订阅后发 `capacity_update`（双通道共用调度器）
- [x] 3.3 单测：submit/启动/终态各触发一次水位上报，数值正确
- [x] 3.4 `contracts/asyncapi-3.0.yaml` 与两份 README 协议表同步

## 4. B：步骤流（后续批次）

- [x] 4.1 调研 codex `--json` 与 claude `stream-json` 的实际事件格式（2026-10-24 本机实测，
  样例落档 `research/`，含 codebuddy 同构确认；opencode 实测发现适配器 `--json` 系无效参数）
- [x] 4.2 `protocol.ts` 定义 `task_step`；`capabilities` 加 `task-step`；Emitter 终态后丢弃步骤 + label 脱敏截断
- [x] 4.3 L1 解析器（codex / opencode）；L2 解析器（claude / codebuddy 改 stream-json）；降级工具 `agent_list` 逐项 `steps` 标注
- [x] 4.3b 修 bug：opencode 适配器 `--json` → `--format json`（实测 `--help` 只有 `--format`）
- [x] 4.3c 用户质疑后全量实测其余 8 个：**全部升级支持步骤流（12/12 覆盖）**：
  qoder/trae/grok 实测 claude 同构；mimo 系 opencode fork 同构；kimi 实测 OpenAI 风格；
  gemini 官方文档；dsh 升 0.2.1-rc.2 后 `--json` 可用；minimax 安装后实测（0.6.13）。
  并修 6 个适配器现存 bug（opencode `--json` 无效、kimi `--headless` 无效、grok/minimax/trae 的
  `run` 子命令不存在、qoder bin 误指 IDE 入口 `qoder` 而非 `qodercli`）
- [x] 4.4 契约与文档同步（asyncapi + 控制面 AgentListItem + README×2 + 协议总览×2 + gen-reference 重生成）；
  单测 6 条（三解析器 fixture + 碎片喂入 + 噪音跳过 + Emitter 收口）

## 5. C：双表面面板（后续批次）

- [x] 5.1 终端常驻状态表（`src/cli/panel.ts`：TTY 检测、四态圆点（执行中蓝/排队琥珀/成功绿/失败红、
  取消灰）、步骤列、耗时走字、容量水位行、固定区域 ANSI 重绘；非 TTY 退化逐行日志；
  任务日志不上主窗口——`panelLog` 过滤 [stdout]/[stderr]/▶ 行）
- [x] 5.2 控制面 Web 面板（`control-plane-page.ts` 内嵌页 + `GET /` 免令牌壳 + `GET /v1/board`
  聚合视图 + `?token=` 兜底（EventSource 无法自定义头）+ SSE 实时日志/终态回放）；
  数据源 `src/app/task-registry.ts`（双通道同一注册表，dispatch 与控制面双写）
- [x] 5.3 测试：注册表 5 条 + 控制面 3 条（面板壳免令牌/无 CORS、board 401→200、query token 口径）
- [x] 5.4 设计评审后 v2（2026-10-25 用户确认设计稿）：
  - 终端面板重写：边框盒引导区（平台/设备/容量/面板四行标签对齐，去掉令牌行）+ 真表格
    （dim 表头 + 固定列宽 + CJK 宽度感知）+ 底部状态栏；重绘换 CUU+CR（修 winpty 下
    `\x1b[F` 失效导致状态行重复打印的 bug）；对齐策略「纯文本算宽、逐格套色」
  - Web 面板 v2：步骤列 = 实时当前步骤 + 蓝色下划线「预览完整步骤」；时间线弹层
    （✓完成/◉进行中/✗失败 + 虚线「待模型规划」占位）；结果弹层三 tab（最终回答 md 渲染 /
    diff 着色 / changedFiles 文件列表点击预览：md 渲染、html iframe 沙箱、图片直显、其余文本）
  - 令牌零操作：serve 启动生成只读内存令牌（task:read/device:read，不落盘、随进程失效）拼进
    面板 URL；页面识别后挪 localStorage 并 history.replaceState 抹除地址栏
  - 数据端：registry 存步骤历史（≤200/任务）+ finalText + diff/changedFiles（cwd 全路径仅服务端
    内部用、不进序列化视图）；7 族解析器加 finalText()；task_status 新增可选 `result` 字段（≤16KB，
    平台同享）；新端点 `/v1/tasks/{id}/steps`、`/v1/tasks/{id}/file`（穿越 403 / 白名单 / 512KB 上限）
- [x] 5.5 v2 测试：steps/file 端点 3 条 + finalText 5 族断言 + 注册表 2 条；全套 120 条通过
- [x] 5.6 二次验收修复（2026-10-25 用户截图驱动）：
  - 终端面板：边框盒顶/底/内容行严格同宽（右 │ 对齐）；盒内行与任务行均插空行拉开行距；
    任务 id 截断到 10 字符；表格分隔线与表头/数据行同宽
  - 步骤合并：supervisor 以 ref→seq 配对，tool_use/tool_result 不再拆成两步（时间线不再多一步、
    started 不再永远悬在「进行中」）；registry 合并时不让 tool_result 覆盖工具名
  - 待办计划（用户指出不能只做 claude）：**7 族解析器全部支持 TodoWrite 类工具计划快照**
    （claude/codebuddy/grok/qoder/trae、opencode/mimo、codex plan item、gemini、kimi、dsh、mcode），
    registry 存 plan，`/v1/tasks/{id}/steps` 返回，时间线弹层顶部显示三态待办（已完成/执行中/待做）；
    「待模型规划」占位只在执行中任务显示（终态不再多出占位步骤）
  - Web 步骤列固定列宽 + 省略号 + 蓝色下划线入口
  - 测试 123 条全过（7 族计划提取、注册表合并/计划）；三门禁全绿
- [x] 5.7 终端面板样式按设计稿 1:1 对齐（2026-10-25 用户指图）：圆角边框（去掉标题）、
  盒内深色底、盒内行与任务行加空行、列宽按设计稿比例（状态 9 / 任务 20 / 工具 16 / 步骤弹性 /
  耗时 6）、任务 id 短截断、表头下分隔线后留空行、状态栏与分隔线间留空行；令牌行仍按上一轮
  「不重复显示令牌提示」的要求不新增（内容决策不变，样式决策照设计稿）
- [x] 5.8 Web 面板产品化重构（2026-10-25 用户指出日志不可读、弹窗潦草与性能风险）：
  - 授权页/主面板统一品牌与卡片视觉；日志/步骤/结果弹窗使用 vw/vh 响应式尺寸并支持全屏
    （含 Escape 退出）；修正全屏时遮罩 padding 未归零的问题
  - 日志从 JSONL 倾倒改为结构化事件卡：7 族事件归一化，tool_use/tool_result 按 ref 合并，
    原始 JSON 折叠为诊断信息；提供搜索、对话/工具/系统/错误筛选、自动跟随与分页加载
  - 性能：日志 600 条有界缓存、默认 120 条可见窗口、120ms 合帧、按 revision 增量更新；
    主表按签名变化重绘、耗时独立更新、后台标签页暂停轮询
  - 浏览器实测授权页/主面板/结构化日志/时间线/结果页与全屏；新增 dashboard-page 7 条模型测试
    （含 dsh callId 配对兼容与 600 条缓存上限）
- [x] 5.9 官网品牌统一（2026-10-25 用户要求）：授权页与首页 Logo 原样内嵌
  `site/src/assets/logo-light.svg`（设备方块 → 出站连线 → 平台圆点），不再使用 AB 蓝色替代标；
  按钮/链接/焦点/选中态/成功态统一采用官网 `#17A67F` 与 accent-high/accent-low token，
  四种任务状态色保留；控制面测试加入品牌资产与主题色防回归断言，浏览器截图验收
- [x] 5.10 结果文件预览与 Office 支持（2026-10-25 用户要求）：
  文件列表展示名称/类型/大小/预览按钮，默认预览首个文件；HTML/PDF 内嵌渲染、图片直显并支持
  点击放大原图，Markdown/JSON/CSV/文本可读化，未知格式下载降级；新增本地 Office 内容预览
  （docx 段落、xlsx 工作表与共享字符串、pptx 幻灯片文本，不上传第三方）；文件 HEAD 元数据、
  浏览器截图与 Office 解析测试通过；修复 ESM 下 require 使用和图片放大函数缺失问题
- [x] 5.8 终端面板按最新参考图紧凑化（2026-10-25 用户指图，覆盖 5.7 的行距与令牌行决策）：
  引导区依次显示平台/容量/面板/令牌且不插空行；平台、面板地址均为蓝色，面板地址不拼接提示文案；
  任务行、底栏不插空行，表头下不画分隔线；补充 ANSI 输出回归测试
- [x] 5.10 终端面板按截图反馈调整主题与留白（2026-10-25 用户指图，覆盖 5.8 的紧凑布局与令牌行）：
  信息区去底色、边框与标签改官网主绿 `#17A67F`；表头加粗并配绿色分隔线；信息行与任务行增加留白；
  平台/面板地址保持蓝色且去下划线；隐藏令牌行；底部运行/排队/成功/失败标签与值分别用蓝/黄/绿/红
- [x] 5.11 终端任务表三列左对齐修复（2026-10-25 用户指图）：状态符号 ●◷✓✗○ 在
  Windows Terminal / Git Bash 按单宽计算，修正状态列补齐宽度，使任务/工具/当前步骤与表头同列起始；
  回归测试逐行比较三列的显示列位置
- [x] 5.12 终端设备字段显示名称而非 ID（2026-10-25 用户指图）：`PanelOptions.deviceId`
  改为 `deviceName`，connect/serve 优先传配置 `label`、缺省回退主机名；deviceId 仅用于授权与连接

## 6. 门禁

- [x] 6.1 批次 A：`npm run gate` / `harness:validate` / `e2e:smoke` 全绿（2026-10-24，
  gate 含 protocol.ts 提案校验与 contracts:check；e2e 10/10 PASS。
  注：e2e 脚本在 `.harness/` 内，capacity_update 的端到端断言需人工补充）
- [x] 6.2 批次 B：gate（曾抓出 asyncapi 漏记 `task-step` 能力，已补）/ harness:validate /
  e2e:smoke 全绿；单测 100 条通过
- [x] 6.3 批次 C：gate / harness:validate / e2e:smoke 全绿；单测 115 条通过。
  注：TTY 面板为 ANSI 渲染层，机检覆盖不到视觉效果，需人工在真实终端验收一次

## 7. 归档

- [ ] 7.1 全部批次完成、人工评审通过后归档，specs 增量合并入 `openspec/specs/`
