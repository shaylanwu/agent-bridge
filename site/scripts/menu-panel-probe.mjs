/**
 * 窄屏菜单面板探针：点开首页菜单按钮，截图并检查面板内条目/可见性。
 * 用法：BASE_URL=... node scripts/menu-panel-probe.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321/agent-bridge';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = process.argv[2] ?? 'scripts/header-shots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const width of [600, 420]) {
  const ctx = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/zh-cn/`, { waitUntil: 'networkidle' });
  await page.click('.ab-menu-btn');
  await page.waitForTimeout(250);
  const info = await page.evaluate(() => {
    const panel = document.querySelector('#ab-mobile-nav');
    const items = [...document.querySelectorAll('#ab-mobile-nav .sl-nav-item')];
    const r = panel.getBoundingClientRect();
    const cs = getComputedStyle(panel);
    const openIcon = getComputedStyle(document.querySelector('.ab-menu-btn .icon-open')).display;
    const closeIcon = getComputedStyle(document.querySelector('.ab-menu-btn .icon-close')).display;
    return {
      open: panel.matches(':popover-open'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      bg: cs.backgroundColor,
      border: cs.borderTopWidth,
      items: items.map((a) => ({ text: a.textContent.trim(), h: Math.round(a.getBoundingClientRect().height) })),
      openIcon,
      closeIcon,
      bodyOverflow: getComputedStyle(document.body).overflow,
      extras: !!document.querySelector('#ab-mobile-nav .ab-mobile-extras'),
    };
  });
  console.log(width, JSON.stringify(info));
  await page.screenshot({ path: `${outDir}/panel-${width}.png` });
  await ctx.close();
}

await browser.close();
