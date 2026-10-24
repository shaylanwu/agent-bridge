# 实施清单：add-website-and-api-docs

> 前置条件：**已满足** —— P0-6 diff / P0-8 服务令牌 / 协议通用化 / 入口分层瘦身 / 本地控制面 C1~C4 全部落地。
> 状态：**方案第 2 版已按成品系统重写（`design.md`）**，等用户决策后按本清单动工。

## 1. 契约层（已完成，站点直接消费）

- [x] 1.1 `contracts/openapi-3.1.yaml`：平台需实现的 4 个 HTTP 端点
- [x] 1.2 `contracts/asyncapi-3.0.yaml`：WS 通道（11 个消息类型 + 错误码枚举）
- [x] 1.3 `contracts/openapi.control-plane.yaml`：本地回环控制面（9 个路径 / 10 个操作）
- [x] 1.4 `scripts/gen-contracts.mjs` + `contracts:check`（进 `npm run gate`）
- [x] 1.5 `doc-contract-check` 覆盖 CLI 命令（6 个）与控制面端点（9 个）—— 站点侧可复用，不必另写

## 2. W1：站点骨架

- [x] 2.1 `site/` 独立 `package.json`（astro 7 + @astrojs/starlight 0.42；**API 渲染改用 CDN 版 Scalar 组件**，
      不进依赖树，避免与 Astro 依赖冲突）
- [x] 2.2 `astro.config.mjs`：导航、i18n（en + zh-CN，`translations` 用 BCP-47 键）、Pagefind 搜索、站点元信息
- [x] 2.6 亮/暗/跟随系统主题：Starlight 自带（默认 `auto` 跟随系统）；Scalar 客户端渲染页由
      `ApiReference.astro` 读 `data-theme` + MutationObserver 同步重建，并隐藏 Scalar 自带开关
- [x] 2.7 UI 设计系统 v3（`site/src/styles/custom.css`）：只覆盖 Starlight 暴露的变量 + 少量结构样式；
      首页组件化（`site/src/components/home/`，中英共用、文案由 `index.mdx` 传入）；
      顶栏 2px 阅读进度条（`public/progress.js`）；全站仅 1 处动效且受 `prefers-reduced-motion` 约束；
      中英排版差异（中文行高 1.8 / 避头尾 / 数字等宽）与 50rem 窄屏断点
- [x] 2.8 顶栏 v2（对齐 Vue 官网口径）：底色与下边框仍通栏，**内容**装进居中容器（max-width 1376px）；
      左区 logo + 16px + 搜索（不再被拉伸到内容列），右区菜单/语言/主题/GitHub；
      窄屏搜索退化为图标并靠右，其右是菜单按钮 —— 无侧栏页面（首页/splash）在
      `Header.astro` 里自带一个 popover 面板（一级菜单 + 语言 + 主题 + GitHub），
      有侧栏页面沿用 Starlight 侧栏汉堡（两边按钮样式统一为幽灵图标）。
      证据：`site/scripts/header-probe.mjs`、`menu-panel-probe.mjs`（多宽度几何 + 截图）
- [x] 2.3 首页（定位 + **读者分叉：平台方 / 本机程序**）+ quickstart + cli 三个页面（en + zh-cn）
- [x] 2.4 `public/` 构建期从 `../../contracts/` 复制 3 份契约 + `llms.txt`（`sync-contracts.mjs`）
- [x] 2.5 `/architecture/`：分层图 + 依赖方向 + 三条红线（唯一上行出口 / 入口只分发 / 回环默认关闭）

## 3. W2：协议区

- [x] 3.1 协议总览（方向表、能力协商、版本规则、15 个受控错误码、排队语义）
- [x] 3.2 消息参考：11 个消息逐字段 + 示例 —— **由 AsyncAPI 契约生成**（不另抄一遍）
- [x] 3.3 WebSocket 通道页：URL / 鉴权 / 心跳（15s）/ 退避（1s→30s）/ 断线丢日志的显式说明

## 4. W3：两条对接路径（第 2 版新增的主干）

- [x] 4.1 `/integrate/platform/`：平台方清单（WS 服务端 + 4 个 HTTP 端点 + scope 校验 + 状态机/watchdog 归属）
- [x] 4.2 `/integrate/local/`：本机程序清单（控制面：令牌、Idempotency-Key、SSE、diff；开篇写明默认关闭/只绑回环/需 scoped 令牌/不返回 CORS）
- [x] 4.3 `/api/`：Scalar 渲染 `openapi-3.1.yaml`（平台方要实现的）+ **静态生成页**用于搜索
- [x] 4.4 `/api/control-plane/`：Scalar 渲染 `openapi.control-plane.yaml`（本机方可调用的）+ **静态生成页**用于搜索

> 选型修正（应"API 文档全局搜索"要求）：Scalar 是客户端渲染，Pagefind 索引不到端点内容，
> 所以端点页由 `gen-reference.mjs` 静态生成，Scalar 页只负责试请求 —— 两者并存。

## 5. W4：版本历史与发布自动化（已落地）

- [x] 5.1 版本历史页：构建期读 `../../CHANGELOG.md` 渲染（一处真源两处呈现）
      —— `site/scripts/gen-changelog.mjs` 只替换页面里 `<!-- CHANGELOG:BEGIN/END -->` 之间的内容，
      frontmatter / 导语 / 版本号规则仍可在站点侧人工编辑；`site-check` 1.8 机检两边是否脱钩
- [x] 5.2 `commitlint` + husky（本地拦 commit 规范）：`commitlint.config.js` + `.husky/commit-msg`，
      `prepare: husky`；正文/脚注行长降到警告级（中文长句不误伤）
- [x] 5.3 `.releaserc.json`（changelog / npm / git / github 插件）
      —— changelog 写入改用 `scripts/semantic-release-changelog.mjs`：现成的
      `@semantic-release/changelog@7` 只能把新版本**前插**（`# Changelog` 会落到版本段下面），
      preset 用 `angular`（`conventionalcommits` 当前主版本要求比 semantic-release 25 更新的 writer）
- [x] 5.4 `.github/workflows/release.yml`（NPM_TOKEN / GITHUB_TOKEN）：改为 `push: main` 触发
      semantic-release（verify job 先跑 typecheck/test/build/smoke + arch/doc/contracts 三道机检）；
      原「tag 触发手工发布」已取消 —— 两种方式并存会双发
- [x] 5.5 `.github/workflows/site.yml`（pre-build 跑 `site:check` → 构建 → 产物自检 → Pages）
      —— 每次 `main` 推送都重建，含 semantic-release 推回的 `chore(release)` 提交，
      所以「发布完版本」到「历史页出现版本」之间没有人
- [x] 5.6 离线取证：`.harness/work/verify-release.mjs` 用 `v0.1.0..HEAD` 的真实提交跑一遍
      notes 生成 + CHANGELOG 写入，断言标题位置/插入位置/h1 唯一/版本段数量（不需要 token 与网络）

## 6. 站点级防漂移（`site/scripts/site-check.mjs`）

- [x] 6.1 CLI 命令页 ↔ `src/cli/dispatch.ts` 的 `COMMANDS` 表：缺一条即红
- [x] 6.2 3 份契约用 `yaml` 解析校验；控制面 10 个端点逐条比对生成页
- [x] 6.3 生成页新鲜度（`gen-reference.mjs --check`）+ i18n 对等（14 页 × 2 locale）

## 7. 视觉修正（2026-10-24，用户反馈）

- [x] 7.1 Qoder CLI 图标改官方亮/暗双版本（`assets/agent-icons/qoder-cli{,-light}.svg`：
      绿内芯 `#2ADB5C` + 白/深外圈，取自 lobehub/lobe-icons 官方彩色版拆色）；
      AgentWall 由「正则抽 `<image href>`」改为 `set:html` 内联双版本 + CSS 按主题切换显隐
- [x] 7.2 交互式 API 页整页底色归还站点 token：Scalar 注入的 `body{background-color:var(--scalar-background-1)}`
      撞上 Starlight 给 body 加的 `dark-mode` 类（Scalar 同名主题类 `--scalar-background-1:#0f0f0f`），
      整页底色被拽离 `--sl-color-bg` → customCss 用 `html body`（特异性 0-0-2）压回站点底色，
      面板/内嵌侧栏/描边全部改引 `--sl-color-*` token，与静态页浑然一色（亮暗双主题实测一致）
- [x] 7.3 **图标资产标准化**（13 个 SVG：12 个 Agent + Qoder 亮色版）：统一 `viewBox="0 0 24 24"`、
      内容 `<g transform>` 归一化到墨迹最大边 20（24 画布内 2 单位安全边距）、居中、无裁切；
      原始画布 24 / 40 / 192 并存曾是"一大一小 + CodeBuddy 光晕被裁"的根因。
      **资产即标准**：官网内联渲染与平台 `logoDataUri` data URI 共用同一份，平台任意尺寸光学大小一致；
      官网图标盒子 18px → 20px（可见内容 ≈16.7px）；两份 README 的 logo 契约同批更新（24×24 / 品牌色 / ~70KB）；
      新增 `site/scripts/icon-audit.mjs` 可复跑审计（viewBox + 像素级墨迹边界 + 溢出检测）
- [x] 7.4 Agent 墙渲染修正（用户复检"仍有明显裁切"的真凶）：原写法 `<svg set:html={item.svg}>` 会套出
      **内层 svg**，内层不跟随 CSS 缩放到容器（按自身 24px 排版），右/下各 4px 被外层 20px 视口裁掉 ——
      12 个图标全被切（opencode 右边框被切到只剩 `[`）。改为 `.home-agent-glyph` 直接内联；
      图标盒子 20px → 22px（可见内容 ≈18.3px，不再缩水）；
      **填充式方块图标统一 5/24 圆角**（Kimi 14.6% → 21%、CodeBuddy 正圆 → 圆角方块、Trae 直角 → 圆角），
      其余字形图标保持官方轮廓；`site-check` 新增 1.6 机检：AgentWall 不得出现 `<svg set:html>` 套娃

## 8. 隔离性验收

- [x] 8.1 `npm pack --dry-run` 产物不含 `site/` 与 `contracts/`（实测 52 文件，两者均为 0）
- [x] 8.2 主包 `dependencies` 仍只有 `ws` + `smol-toml`
- [x] 8.3 站点构建失败不影响 `npm run gate`（实测 gate 全绿）
- [ ] 8.4 打一个 `feat:` 验证全链路：版本号 / CHANGELOG / tag / Release / 站点历史页自动更新

## 9. 归档

- [ ] 9.1 人工评审通过后合并 spec 增量
- [ ] 9.2 提案目录移入 `openspec/changes/archive/YYYY-MM-DD-add-website-and-api-docs/`
