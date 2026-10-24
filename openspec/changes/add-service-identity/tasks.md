# 实施清单：add-service-identity

## 1. 设计与提案

- [x] 1.1 建 `proposal.md` / `tasks.md` / `specs/bridge-protocol/spec.md` / `specs/service-identity/spec.md`
- [x] 1.2 明确"默认不强校验、带令牌必校验"的兼容策略（老平台零破坏）
- [x] 1.3 明确不做本地监听端口（护栏 protocol-boundary-check 硬约束）

## 2. 实现

- [x] 2.1 `src/service-token.ts`：令牌形态 `abs_<kid>_<secret>`、SHA-256 入库、timingSafeEqual 校验、
      scope 判定、TTL、吊销、轮换宽限期
- [x] 2.2 `src/audit.ts`：单行 JSONL 审计，0600，脱敏（不落令牌/凭据）
- [x] 2.3 `src/protocol.ts`：`run_task.requestedBy/purpose/serviceToken`、`hello.capabilities`、
      `task_status.requestedBy`；`assertServerMessage` 做形状与长度校验
- [x] 2.4 `src/config.ts`：`require_service_token`（默认 false）读取
- [x] 2.5 `src/cli.ts`：`services issue|list|revoke|rotate` 命令组；run_task 校验失败回 `task_status.failed`
- [x] 2.6 终端输出：令牌明文只在 issue 时打印一次，其余一律尾号

## 3. 测试

- [x] 3.1 单测：issue → verify 通过；错令牌 / 吊销 / 过期 / scope 不足全部拒绝
- [x] 3.2 单测：轮换宽限期内新旧令牌都可用，宽限期后旧令牌失效
- [x] 3.3 单测：登记表文件 0600 且不落明文
- [x] 3.4 单测：`assertServerMessage` 对 requestedBy/purpose/serviceToken 的长度与类型约束
- [x] 3.5 单测：审计行是合法 JSON 且不含令牌片段

## 4. 文档与门禁

- [x] 4.1 两份 README：协议表、"服务身份与作用域"章节、平台侧接入清单（3 处改动）
- [x] 4.2 CHANGELOG `Unreleased` 记录
- [x] 4.3 `npm run gate` 全绿；`npm run e2e:smoke` 覆盖 capabilities 字段

## 5. 归档

- [ ] 5.1 人工评审通过后合并 spec 增量进 `openspec/specs/`
- [ ] 5.2 提案目录移入 `openspec/changes/archive/YYYY-MM-DD-add-service-identity/`
