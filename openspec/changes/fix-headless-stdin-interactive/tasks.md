# 任务清单：fix-headless-stdin-interactive

> 条目以 `N.N` 开头（OpenSpec 校验要求）；完成一项勾一项并附证据。
> 本提案**不带 specs/ 增量**：规格已写明「除受控交互适配器外，子进程 stdin SHALL 保持 ignore」，
> 缺的是实现对齐。

## 1. 取证（先于改动）

- [x] 1.1 微实验：`codex exec --json` 在 `stdio[0]='ignore'` 下 19.9s 完成 879 字节；
      `stdio[0]='pipe'`（不写入）25s 零字节、不退出
- [x] 1.2 反向实验：把改动回退并重建 dist 后，网关 e2e 仍然 17/17（52s）
      ——证明 2026-11-28 首轮那 6 项失败与本改动无关，属瞬时环境（首轮 4m09s）
- [x] 1.3 `TaskHandle.write()` 全仓零调用方（`grep "\.write(" src` 无 handle 调用）

## 2. 实现

- [x] 2.1 `src/core/task-supervisor.ts`：`stdinMode` 恒 `'ignore'` + 根因/实测/规格出处注释
- [x] 2.2 同文件类型注释：`interactive` 不控制 stdin；`write()` 对 headless 恒 `false`

## 3. 测试

- [x] 3.1 `test/supervisor-headless-stdin.test.ts`（2 例，真子进程：假 CLI 等 stdin EOF 再吐标记）
- [x] 3.2 先红后绿：`stdinMode` 改回 `interactive ? 'pipe' : 'ignore'` → 两例都变红
      `expected 'timeout' to be 'success'`；复原即绿

## 4. 验证

- [x] 4.1 `npm run gate` 全绿；`npm run harness:validate` 全绿；全量 vitest 不回归
- [x] 4.2 `E2E_INTERACTION=1 E2E_AGENT=codex npm run e2e:gateway` 17/17（回归确认）

## 5. 归档

- [ ] 5.1 由人工执行 `mv openspec/changes/fix-headless-stdin-interactive openspec/changes/archive/<日期>-fix-headless-stdin-interactive`
