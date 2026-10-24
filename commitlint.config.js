/**
 * 提交信息规范 —— 语义发布的前提。
 *
 * semantic-release 只认 Conventional Commits：`feat` 升 minor、`fix` 升 patch、
 * `feat!` / `BREAKING CHANGE:` 升 major、其余（docs/chore/test/refactor/style/ci/build）不发布。
 * 提交信息写错不会报错，只会让版本号和 CHANGELOG 悄悄错掉 —— 所以在 commit-msg 阶段就拦。
 *
 * 与 `.releaserc.json` 的 `preset: conventionalcommits` 是同一套规则：
 * 校验端与生成端读同一族 preset，否则会出现"提交通过了但没进 CHANGELOG"的静默漏记。
 */

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 本项目的中文提交正文常有长句，100 字符一刀切会误伤 —— 放宽并降为警告（不阻断提交）。
    'body-max-line-length': [1, 'always', 200],
    'footer-max-line-length': [1, 'always', 200],
    // 协议破坏性变更必须显式写成 feat!:/BREAKING CHANGE:，它是升 major 的唯一信号，
    // 与 PROTOCOL_VERSION 递增是同一条规则的两端（见 .harness/rules/protocol-contract-rules.md）。
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
  },
};
