# VERSIONING.md — 版本号判定规则

> 本文回答一个问题：**这批改动该发 patch、minor 还是 major？**
> 判定依据是**代码事实**（契约与行为有没有变、平台要不要跟着改），不是提交标题里自己写了什么，
> 也不是谁拍脑袋。
>
> 红线仍以 `.harness/rules/release-rules.md` 为准（发布链路、禁止项、回滚）；
> 本文是那套红线里「版本语义」一节的**可操作细则**，冲突时以红线为准。

---

## 0. 一句话原则

```
版本号 = f(改动对平台可见契约的影响)
        ↑
   看代码事实，不看提交自称
```

三条推论：

1. **提交类型是"声明"，代码才是"事实"**。声明与事实不符时，改声明（重组提交），不改事实。
2. **没有平台可见影响的改动，不该出现在任何版本里**（测试、文档、CI、内部重构）。
3. **契约早就承诺过的事，实现在补 = patch**（不是 minor）——平台本来就在等这个行为。

---

## 1. 判定表（先看这一节）

| 事实 | 判定 | 提交类型 | 例子（本仓真实发生） |
| --- | --- | --- | --- |
| 修复缺陷 / 行为与已发布契约不符 / 崩溃 / 超时 / 竞态 | **patch** | `fix:` | 1.2.1 `fix(acp)` stdin EPIPE 不再终止 bridge |
| 把「规格写了但实现没做」的承诺真正实现 | **patch** | `fix:` | 1.2.3 `fix(core)` get_task 单响应 1 MiB 上限；1.2.2 `fix(protocol)` 终态 `task_status.result` |
| 性能优化（行为不变） | **patch** | `perf:` | 系统代理探测按进程缓存 |
| 新增平台可用能力：新命令、新 wire 消息、**向后兼容的新字段/新能力/新错误码** | **minor** | `feat:` | 1.1.0 `feat(codex)` 重连告警上行成日志；1.2.0 `feat(errors)` `context_exhausted` 落地 |
| 新增受管 CLI / 让某个工具新开一条已经声明过的通道 | **minor** | `feat:` | agy 启用 ACP 会话 |
| 只改测试 / 只改文档 / 只改规格与提案 / 只改 CI | **不发版** | `test:` `docs:` `ci:` `build:` | 1.2.3 里那 6 个测试与规格提交 |
| 内部重构，行为与契约都不变 | **不发版** | `refactor:` | 拆 `result-text.ts` 之类 |
| 删字段 / 改字段名 / 改字段语义 / `PROTOCOL_VERSION` 递增 | **major** | `feat!:` 或 `BREAKING CHANGE:` | （尚未发生，发生前必须先提案 + 人工审批） |

**判定顺序**（按顺序问，命中即停）：

1. 平台要跟着改代码才能继续工作吗？→ 是：**major**（且先提案审批，不许直接推）
2. 平台能用到此前用不到的能力/字段/错误码吗？→ 是：**minor**
3. 平台可见行为变了吗（修 bug、行为对齐契约、性能）？→ 是：**patch**
4. 以上都不是，只是我们自己内部更好？→ **不发版**

---

## 2. 容易判错的三组边界

### 2.1 「契约早写了、实现没做」→ patch，不是 minor

`bridge-protocol` 写着「单响应 1 MiB 是默认可配置安全策略」，实现里一个字节判断都没有。
补上它就是**修 bug**：平台不需要新增任何解析逻辑，它在等的是本来说好的行为。
把它写成 `feat` 会把 minor 白送出去，还会让 CHANGELOG 看起来像新增功能。

反向也成立：**规格没写、实现新加**才叫新增能力 → minor（且要同批更新两份 README 与规格）。

### 2.2 新增受控错误码 → minor，但不必递增 `PROTOCOL_VERSION`

本仓约定：新增字段/能力/错误码**不**递增 `PROTOCOL_VERSION`（向后兼容），
但对平台而言是"以前不会出现、现在会出现"的新取值 —— 属新增能力 → **minor**。

### 2.3 改 CI / 改流水线 → `ci:`/`chore:`，绝不用 `fix:`

2026-10-24 实测教训：三次流水线修复写成 `fix(release)` / `fix(site)`，版本从 0.2.0 顶到 0.2.2，
**三个 patch 版本里没有一个包含用户可见改动**。修 CI 不产生平台可见变化，不该占版本号。

---

## 3. 本仓的发布机制（为什么类型这么重要）

`.releaserc.json` + `release.yml`：**push 到 `main` = 可能发版**。

```
commit（conventional）
  → commitlint 本地拦截非法格式
  → push main
    → release.yml：verify（typecheck / test / build / smoke / arch / doc / contracts）
      → semantic-release（preset: angular）
           feat                → minor
           fix / perf          → patch
           feat! / BREAKING    → major
           docs/chore/test/refactor/style/ci/build → 无发布内容，workflow 什么都不做
      → tag v<version> + CHANGELOG + npm publish + GitHub Release
```

**所以两句话要背下来**：

- 把 `fix` 写成 `chore` = **改了代码却不发版**（平台永远收不到）；
- 把 `chore` 写成 `fix` = **只有测试也发版**（版本号噪音，CHANGELOG 里查无实质改动）。

---

## 4. 提交类型与实际内容不符时：重组（只在未推送时）

适用场景：干活时用了保守的 `chore`/`test` 类型，事实却是可发布的行为变更。
（本仓 1.2.3 就是这么发的：8 个 `chore`/`test`/`docs` 提交，其中 2 个是实质修复。）

```bash
# 1) 先确认这些提交还没推送（有输出 = 还没推，安全）
git log --oneline origin/main..main

# 2) 软重置到远端，改动全部回到暂存区（不丢内容）
git reset --soft origin/main && git reset HEAD .

# 3) 按语义逐个重建：fix 的、docs 的、test 的分开
git add <src 文件 + 对应测试 + openspec 提案>
git commit -m "fix(core): …（说清事实影响，别复述文件名）"
...

# 4) ⛔ 必做校验：重组前后内容必须零差异
git diff --stat <旧 tip 提交> main      # 必须为空
```

规则：**重组只允许发生在未推送的本地提交上**。已推 main 的提交不要再改（会 force push）。

---

## 5. 发布前后各做一次核对

### 5.1 发版前：确认真源（不许凭记忆）

```bash
npm view agent-bridge-service dist-tags          # 线上真实 latest
git fetch --tags && git tag --sort=-creatordate  # 本地 tag 可能是陈旧的，先 fetch
head -12 CHANGELOG.md                            # 最新版本段
```

三处必须一致。**2026-11-28 教训**：我凭记忆里「1.0.0 尚未发布」+ 未 fetch 的本地 tag（只到 v1.1.0），
在线上已是 1.2.2 时仍说"1.1.0"，把用户弄糊涂了。记忆里的版本断言一律当过期处理。

### 5.2 发版后：四项核对

```bash
npm view agent-bridge-service version            # 新版本号
git ls-remote --tags origin | tail -3            # 新 tag 已推送
head -16 CHANGELOG.md                            # 新版本段与预期一致
cd site && node scripts/gen-changelog.mjs         # 站点版本历史页跟上（不发版，docs(site) 提交）
```

站点页落后时 `site:check` 会红 —— 它是 `CHANGELOG.md` 的镜像，不维护第二份真源。

---

## 6. 三个真实案例（可直接对照）

| 版本 | 内容 | 为什么是这一档 |
| --- | --- | --- |
| **1.2.0** | `feat(errors)` `context_exhausted`；`fix(emitter)` 终态后 get_artifact | 出现了一个**此前不存在**的受控错误码 → 平台要识别新取值 → minor |
| **1.2.2** | `fix(protocol)` 终态 `task_status.result` | 契约从上线起就写着这个字段，实现从没发过 → 行为对齐契约 → patch |
| **1.2.3** | `fix(core)` get_task 1 MiB 上限；`fix(supervisor)` headless stdin 恒 ignore | 两处都是"规格写了、实现没做"，无新字段/新能力 → patch；同批 6 个测试与规格提交不产生发布内容 |

---

## 7. 禁止项（红线摘要，详见 `release-rules.md`）

- ⛔ 手工 `git tag`：会与 semantic-release 抢版本号（唯一例外：历史基线 tag，需人工审批）。
- ⛔ 手工改 `package.json` 版本号、手工 `npm publish`。
- ⛔ `git push --tags` 批量推送、force push、删除已有 tag、`npm unpublish`。
- ⛔ 版本算错时**不要**删 tag / unpublish：补发一个更高的版本，并在 Release 说明里指向前一个。

---

## 8. 本文的维护

- 判定表（§1）随 `PROTOCOL_VERSION` 语义演进同步；新增一类改动就在表里加一行。
- 每次出现"类型与事实不符"的事故，在 §4 或 §6 补一条案例，而不是只在聊天里总结。
- 已知过期内容：`.harness/rules/release-rules.md` §现状写「package.json 0.1.0、npm 仍未发布」，
  已与 1.2.x 不符 —— 该文件仅人工维护，需人工更新（Agent 不修改 `.harness/`）。
