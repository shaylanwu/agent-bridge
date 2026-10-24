# 变更提案：任务终态回传工作区 diff（P0-6）

## Why

编排平台（e2e-pilot 及任何第三方系统）的「修复」业务线需要把**文件级 diff** 交给人工审核
（`RepairResult.diff` / `changedFiles`）。当前 bridge 只回传 `task_log` 原始 stdout：AI 编码 CLI 的控制台输出里
通常没有完整 unified diff，平台拿不到可审核的产物，人工审核流程在设备上执行时被卡死。

这不是单一平台的诉求：任何"让远端设备上的 Agent 改代码、再把改动拿回来评审"的系统都需要同一份能力。
因此按**通用能力**实现：开关在报文字段与本地配置两处，语义与任何业务无关。

## What Changes

- **新增 `src/git.ts`**：工作区差异捕获（唯一实现，runner 与未来的 `prepare_workspace` 复用同一函数）。
  - 判定是否 git 工作树（`git rev-parse --is-inside-work-tree`）；非 git 目录返回空结果，**不报错**。
  - 已跟踪改动：`git diff --no-color`；未跟踪文件：先 `git add -N -- <paths>` 再取 diff，取完
    `git reset -q -- <paths>` 还原索引（**不留 intent-to-add 残留，实际上只读**）。
  - `changedFiles` 走 `git diff --name-only`（仓库相对路径）。
  - 上限默认 256 KB，按行边界截断并置 `diffTruncated: true`；`changedFiles` 上限 500 条。
- **协议 `src/protocol.ts`**（仅新增可选字段，`PROTOCOL_VERSION` 保持 1 —— 按"新增可选字段 = 同版本"规则）：
  - `run_task.captureDiff?: boolean`（缺省 false；平台显式要求才捕获）
  - `task_status.diff?: string` / `changedFiles?: string[]` / `diffTruncated?: boolean`
- **`src/config.ts`**：新增 `diff_max_bytes`（默认 262144），`AGENT_BRIDGE_DIFF_MAX_BYTES` 可覆盖；
  `captureDiff` 未下发时可按 `diff_default = true` 全局开启（默认关闭）。
- **`src/runner.ts`**：终态收口 `finish()` 内统一补捕获（成功/失败/超时/取消都给 diff —— 改坏一半也要能审核）。
- **文档**：两份 README 的协议表 + 安全边界表 + 示例报文同步；CHANGELOG 记录。

## Impact

- 对平台（第三方）：纯增量。不发 `captureDiff` 就完全等同今天的行为；老平台不受影响。
- 风险面：`git` 子进程的调用必须是参数数组（无 shell）；非 git 目录 / 超大仓库 / 二进制文件都需降级不报错。
- 性能：只在终态执行一次，且 `git` 有 8s 超时；不影响流式日志时延。
- 安全：diff 内容可能含敏感字符串 —— 与 `task_log` 同级别对待，平台侧自行管控存储；
  bridge 侧**不做**密钥上传，也不读凭据文件。
