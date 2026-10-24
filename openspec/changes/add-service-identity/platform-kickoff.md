# e2e-pilot 平台侧 P0-8（服务身份）开工包

> 本文是**可直接贴进 e2e-pilot 新会话**的开工材料（贴「第 1~6 节」即可开工）。
> 设备侧 agent-bridge 的 P0-8 已全部实现并验证（typecheck / 80 项单测 / e2e:smoke 全绿），
> 本文档描述的 bridge 侧行为均为**已上线事实**，平台侧按此对接，不要更改 bridge 侧。

---

## 1. 背景一句话

agent-bridge（设备侧，npm 包 `agent-bridge-service`）已支持**服务身份三件套**：
第三方后台服务（如 repair-orchestrator）可以凭 scoped 服务令牌代表用户下发/取消任务，
bridge 校验令牌并把调用方身份回显到终态报文，供平台落库审计。
当前缺口全在平台侧：报文不带三件套、`bridge_task_runs` 没有 `requested_by` 列、
controller 不识别服务调用。

## 2. bridge 侧已就绪的对接事实（照此对接）

**wire 报文**（`run_task` / `cancel_task` 均可选携带，全小驼峰）：

```jsonc
{ "type": "run_task", "taskId": "...", "agentType": "...", "cwd": "...",
  "args": [], "prompt": "...", "timeoutMs": 60000,
  "requestedBy": "svc:repair-orchestrator",   // ≤128 字符，调用方标识
  "purpose": "repair",                        // ≤64 字符，业务意图（可选）
  "serviceToken": "abs_<kid>_<secret>" }      // ≤256 字符，一旦携带 bridge 必须校验
```

- **三个字段全部可选**：不带 = 完全 v1 行为，零破坏（这就是平台侧可以分步上线的原因）。
- **令牌格式**：`abs_<kid>_<secret>`，设备侧用 CLI 签发：
  `agent-bridge-service services issue --name repair --scopes task:create,task:cancel`
  （存储在设备本地 `~/.agent-bridge/services.json`；支持 revoke / rotate 带 24h 宽限）。
  ⇒ **平台拿到令牌的唯一途径是用户在设备上签发后录入平台**，属带外配置，不需要平台实现签发。
- **scope 集合**（受控枚举）：`task:create` / `task:cancel` / `task:read` / `device:read`。
  run_task 要求 `task:create`，cancel_task 要求 `task:cancel`。
- **校验失败行为**：bridge 立即回 `task_status { status:'failed', errorCode, error }`，
  errorCode 映射：`missing → unauthorized`、`expired/revoked → token_expired`、
  `scope → insufficient_scope`、其余（malformed/unknown-kid/mismatch）`→ invalid_token`。
- **回显**：终态 `task_status` 报文带 `requestedBy`（下发时收到的原值），供平台对账审计。
- **校验成功也落审计**（设备本地 audit 文件），与平台侧 `requested_by` 列互为印证。

## 3. 平台侧数据流（目标态）

```
repair-orchestrator ──POST /api/bridge/tasks（用户JWT + serviceIdentity 字段）──▶ controller
controller：授权决策（requestedBy 是否允许代表该 user/device 下发）── 越权 403
controller ──startTaskRun(deviceId, userId, cmd + serviceIdentity)──▶ gateway
gateway：落库（含 requested_by） + WS 下发 run_task（含三件套）
bridge：校验 abs_ 令牌 → 通过则执行 / 失败则回 failed + errorCode
bridge ──终态 task_status（回显 requestedBy）──▶ gateway（对账用，不重复落库）
```

分工原则：**平台管授权**（这个服务身份能不能代表这个用户/这台设备），
**bridge 管认证**（abs_ 令牌本身真伪、scope、吊销）。两层都过才执行。

## 4. 三处改动（含精确落点）

### 改动 ① 落库链：`requested_by` 列贯通（migration → server → repo → shared）

1. **新建 migration**（最新编号是 024，下一个用 025）：
   `packages/db/migrations/025_bridge_task_runs_requested_by.sql`
   ```sql
   ALTER TABLE bridge_task_runs ADD COLUMN requested_by text;
   ```
   `025_bridge_task_runs_requested_by.down.sql`：
   ```sql
   ALTER TABLE bridge_task_runs DROP COLUMN IF EXISTS requested_by;
   ```
   可空、不加 NOT NULL——历史行无值，语义就是"用户本人通过 UI 下发"。

2. **`packages/test-kernel/src/api/server.ts` L808** `POST /api/bridge/task-runs`：
   body 增加可选 `requestedBy`，透传给 `deps.bridgeTaskRepo.create({...})`：
   ```ts
   requestedBy: typeof req.body?.requestedBy === 'string' ? req.body.requestedBy : undefined,
   ```

3. **`packages/test-kernel/src/infra/pg/bridge-task-repo.ts`**：
   - `RunRow`（L12）加 `requested_by: string | null;`
   - `toRun()`（L34）加 `requestedBy: r.requested_by ?? undefined,`
   - `create()`（L61）input 加 `requestedBy?: string;`，INSERT 列与值各加一项（第 10 个参数）。

4. **`packages/shared/src/types/bridge.ts` L62** `BridgeTaskRun` 加：
   ```ts
   /** 服务调用方标识（如 svc:repair-orchestrator）；缺省 = 用户本人 UI 下发 */
   requestedBy?: string;
   ```

### 改动 ② 网关：`startTaskRun` 报文带三件套 + 落库带 requested_by

`packages/orchestrator/src/modules/bridge/bridge.gateway.ts` L365 `startTaskRun()`：

1. `cmd` 参数（L368-379）追加：
   ```ts
   /** P0-8 服务身份：透传给 bridge 校验，requestedBy 落库审计 */
   requestedBy?: string;
   purpose2?: never;          // 不要加——purpose 已被业务枚举占用，别混淆
   serviceToken?: string;
   ```
   （实际只加 `requestedBy` 与 `serviceToken` 两个字段即可；`purpose` 业务字段已存在，
   bridge 侧的 `purpose` 语义与之天然同源，无需重复传。）

2. 落库 body（L396-406）加 `requestedBy: cmd.requestedBy,`。

3. WS 报文（L407-417）加：
   ```ts
   requestedBy: cmd.requestedBy,
   serviceToken: cmd.serviceToken,
   ```
   注意：`JSON.stringify` 会自动丢弃 `undefined` 字段——不带时报文与 v1 完全一致，
   不要写成空字符串。

4. （可选对账，不阻塞验收）终态处理（L482-497）可读取 `msg['requestedBy']`
   与内存 state 比对，不一致打 warn——正常情况两者相等。

### 改动 ③ 控制器：`/api/bridge/tasks` 服务调用分支

`packages/orchestrator/src/modules/bridge/bridge.controller.ts` `@Post('tasks')`（约 L1-100）：

现状：`me(req)` 用户态鉴权 + 设备归属校验 → `startTaskRun(deviceId, userId, {...})`。

新增（保持用户态鉴权不变，服务身份是**叠加**不是替换）：

1. 请求体增加可选字段：
   ```ts
   { deviceId, agentType, cwd, prompt?, args?, timeoutMs?,
     purpose?, refType?, refId?, requestedBy?, serviceToken? }
   ```
2. 授权决策（平台侧唯一的鉴权逻辑，简单起步即可）：
   - `requestedBy` 非空但不在平台配置的服务白名单（env `BRIDGE_SERVICE_ALLOWLIST`，
     逗号分隔，如 `svc:repair-orchestrator`）→ 403 `service_not_allowed`；
   - `serviceToken` 存在但 `requestedBy` 缺失 → 400（三件套要么不带要么成对带）；
   - 服务身份**必须仍走用户 JWT**（`me(req)` 不变）——即"代表用户 X"的 X 仍由 JWT 定，
     服务身份只决定"谁在替 X 操作"，设备归属校验照旧执行。
3. 透传给 `startTaskRun` 的 cmd 加 `requestedBy` / `serviceToken`。
4. 返回值不变；`requested_by` 由前端从任务详情（repo 读出）展示，本次不改 UI 也可验收。

> repair-orchestrator 的 `BridgeCodeAgentAdapter`
> （`packages/repair-orchestrator/src/repair/bridge-adapter.ts` L61）调用
> `/api/bridge/tasks` 时在 body 里补 `requestedBy: 'svc:repair-orchestrator'` 与
> `serviceToken`（从其配置读）即可成为第一个真实调用方——其代码注释里
> "服务间调用需要令牌"的 TODO 正是这一条，属后续接通项，不阻塞本次三处改动。

## 5. 验收标准（完成前逐条取证）

1. **兼容性零回归**：不带三件套走原 UI 流程下发一个任务，报文与库表行为与改动前一致
   （`requested_by` 为 NULL）。
2. **贯通**：带 `requestedBy` 下发 → `bridge_task_runs.requested_by` 落值可查
   （`SELECT task_id, requested_by FROM bridge_task_runs ORDER BY started_at DESC LIMIT 1`）；
   bridge 侧日志/审计显示收到三件套且校验通过。
3. **错误令牌**：serviceToken 填一个伪造值 → 任务立刻 failed，错误信息含
   invalid_token（bridge 侧 tokenDenyCode 映射），库表 status='failed' 且 requested_by 已落。
4. **越权 403**：requestedBy 不在白名单 → controller 直接 403，不下发、不落库。
5. **migration 可回滚**：down 脚本执行后表结构恢复。
6. e2e-pilot 自身的既有测试套件全绿（migration 变更不破坏 023/024 的既有断言）。

## 6. 红线与注意事项

- **不要动 bridge 侧任何东西**（协议字段名、错误码、令牌格式均已冻结并过 doc-contract 机检）。
- 字段名严格小驼峰：`requestedBy` / `serviceToken`（bridge 按 wire 契约解析，大写会静默忽略）。
- `serviceToken` 是敏感值：平台侧日志与库表**都不要存它**（库表只存 `requested_by`）；
  gateway 内存中的 state 也不要把它塞进 SSE 推给前端。
- 平台侧不需要实现 abs_ 令牌的密码学校验——那是 bridge 的职责；平台只做第 4 节的授权决策。
- 若后续要做"服务令牌录入 UI"（用户把设备上签发的 abs_ 令牌贴进平台），
  属独立需求，本次不做。

## 7. bridge 侧参考（e2e-pilot 会话用不到，仅供溯源）

- wire 契约：`agent-bridge/src/protocol.ts`（`ServiceIdentity`，L112-123）
- 令牌实现：`agent-bridge/src/infra/service-token.ts`（issue/verify/rotate/revoke）
- 校验门：`agent-bridge/src/app/service-gate.ts`（审计 + tokenDenyCode 映射）
- 下发处理：`agent-bridge/src/app/task-dispatch.ts`（gate → 执行 → 终态回显 requestedBy）
