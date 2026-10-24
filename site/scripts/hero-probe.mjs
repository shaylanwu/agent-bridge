/**
 * 首页 CTA 按钮探针：验收「主要动作 / 次要动作」在视觉上不同权。
 *
 * 背景（2026-10-24 事故）：Starlight 0.42 的 hero action 默认 variant 就是 `primary`，
 * 所以「如何工作」不写 variant 时会和「快速开始」长成同一个实心绿按钮。
 *
 * 用法：BASE_URL=... node scripts/hero-probe.mjs [outDir]
 * 产物：hero-{light,dark}.png（静态）+ hero-{light,dark}-hover.png（悬停次按钮）
 * 判定：两份主题下都必须 ok，否则退出码 1。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4399/agent-bridge';
const outDir = process.argv[2] ?? 'scripts/hero-shots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;

for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 860 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/zh-cn/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const actions = await page.$('.hero .actions');
  const box = await actions.boundingBox();
  const clip = {
    x: box.x - 40,
    y: box.y - 70,
    width: box.width + 80,
    height: box.height + 140,
  };
  await page.screenshot({ path: `${outDir}/hero-${scheme}.png`, clip });

  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.hero .actions a')].map((a) => {
        const cs = getComputedStyle(a);
        return {
          text: a.textContent.trim(),
          variant: a.classList.contains('primary')
            ? 'primary'
            : a.classList.contains('secondary')
              ? 'secondary'
              : a.classList.contains('minimal')
                ? 'minimal'
                : '(none)',
          color: cs.color,
          bg: cs.backgroundColor,
        };
      }),
    );

  const [main, secondary] = await read();
  const checks = [
    ['两个 CTA 都在', Boolean(main && secondary)],
    ['主要动作是 primary 变体', main.variant === 'primary'],
    ['次要动作不是 primary 变体', secondary.variant !== 'primary'],
    ['两者底色不同', main.bg !== secondary.bg],
    ['次要按钮不占品牌色实心', secondary.bg !== main.bg],
  ];

  console.log(`--- ${scheme} ---`);
  for (const r of [main, secondary]) {
    console.log(`  ${r.text.padEnd(6)} variant=${r.variant.padEnd(9)} bg=${r.bg} color=${r.color}`);
  }
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }

  // 悬停次要按钮：只允许「描边/文字转品牌色」，底色不得变成主按钮的实心色
  await page.hover('.hero .actions a:not(.primary)');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/hero-${scheme}-hover.png`, clip });
  const hovered = await read();
  const hoverBgOk = hovered[1].bg !== hovered[0].bg;
  console.log(`  ${hoverBgOk ? 'ok  ' : 'FAIL'} 悬停时底色仍与主按钮不同（hover bg=${hovered[1].bg}）`);
  if (!hoverBgOk) failed++;

  await ctx.close();
}

await browser.close();
console.log(`\n截图：${outDir}/hero-{light,dark}.png、hero-{light,dark}-hover.png`);
process.exit(failed === 0 ? 0 : 1);
