# 四道关卡的判定与反例

## 关卡一（brainstorming）判定表

| 需求原话 | 歧义点 | 必须澄清 |
| --- | --- | --- |
| 「支持第三方对接」 | bridge 是客户端，平台才是服务端；对方要实现 5 个端点 | ✅ |
| 「支持多平台」 | 一个进程连多个平台？还是一台机器绑多个 device？ | ✅ |
| 「加个 daemon」 | 系统服务？还是 `&` 后台？Windows 怎么装？ | ✅ |
| 「修一下 status 慢」 | 缓存失效策略？异步化？并发探测？ | ✅ |
| 「README 加一句说明」 | 无 | ❌ 直接做 |

反例（不合格的澄清）：

> 「你想用方案 A 还是方案 B？A 的优点是…，B 的优点是…」

合格写法：

> 「我理解你要的是 X。关键取舍是 Y，我默认选 Y1（理由一句话）。这样做的代价是 Z，可以接受吗？」

## 关卡二（writing-plans）粒度

不合格：

```
- [ ] 1.1 实现白名单
- [ ] 1.2 写测试
```

合格：

```
- [ ] 1.1 `src/config.ts`：新增 `allowedCwd?: string[]`，从 config.toml 的 `allowed_cwd` 读取（缺省 undefined=不限制）
- [ ] 1.2 `src/cli.ts`：connect 时把 `cfg.allowedCwd` 传入 startTask
- [ ] 1.3 `test/bridge.test.ts`：补 3 条（在范围内 success / 越界 failed / 未配置放行），`npm test` 全绿
```

判据：别人拿着这一行能独立判断"做完了没有"。

## 关卡三（systematic-debugging）常见违规

| 违规 | 表现 | 正确做法 |
| --- | --- | --- |
| 猜修法 | 看到报错直接加 `try/catch` 或 `|| true` | 先复现、拿到真实堆栈 |
| 改多处 | 一次改 5 个文件"应该能好" | 一次只验证一个假设 |
| 忽略环境 | Windows 上按 Linux 推断 | 先确认 `process.platform` 分支 |
| 用单测代替复现 | 单测绿了就说修好了 | 用真实命令复现原问题 |

本项目真实案例：`probeVersion` 曾从 stderr 提取版本号，失败时把 `Node.js v24.11.1` 当成工具版本，
界面显示「装坏 24.11.1」。根因 = 提取源选错，不是工具坏了。→ 结论写进代码注释，避免回归。

## 关卡四（verification-before-completion）证据清单

| 变更类型 | 最低证据 |
| --- | --- |
| 纯文档 | `npm run harness:validate` 通过（含 doc-contract-check） |
| src 逻辑 | `npm run gate` 全绿 + 相关单测输出 |
| 协议 / 适配器 | 上述 + mock 平台端到端跑通（`skills/protocol-e2e`） |
| 授权流程 | 上述 + 真实 `connect` 至少一次（可用 `--token` 免授权路径先验通道） |

⛔ 「我跑过了，没问题」= 无效证据；必须贴命令与输出。
