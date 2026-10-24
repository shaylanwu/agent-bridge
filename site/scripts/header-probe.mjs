/**
 * 顶栏几何探针：多宽度测量 header 内各元素的 x/宽度，并截顶栏区域图。
 * 只读不改。用法：node scripts/header-probe.mjs [outDir]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321/agent-bridge';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = process.argv[2] ?? 'scripts/header-shots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const pages = [
  ['home', `${BASE}/zh-cn/`],
  ['doc', `${BASE}/zh-cn/quickstart/`],
];
const widths = [1600, 1440, 1376, 1200, 1024, 900, 800, 700, 600, 420];

for (const [name, url] of pages) {
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    const data = await page.evaluate(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: Math.round(r.x),
          right: Math.round(r.right),
          w: Math.round(r.width),
          display: cs.display,
          vis: cs.visibility,
        };
      };
      const header = document.querySelector('header.header');
      const hr = header.getBoundingClientRect();
      const cs = getComputedStyle(header);
      return {
        viewport: window.innerWidth,
        header: {
          w: Math.round(hr.width),
          padL: cs.paddingLeft,
          padR: cs.paddingRight,
          bg: cs.backgroundColor,
        },
        logo: box('.title-wrapper'),
        siteTitle: box('.title-wrapper a'),
        search: box('site-search button[data-open-modal]'),
        searchIconOnly: (() => {
          const sp = document.querySelector('site-search button[data-open-modal] span');
          return sp ? getComputedStyle(sp).display : null;
        })(),
        navMenu: box('.sl-nav-menu'),
        rightGroup: box('.right-group'),
        social: box('.social-icons'),
        lang: box('starlight-lang-segment'),
        theme: box('[data-theme-toggle]'),
        menuBtn: box('.ab-menu-btn') ?? box('.sl-menu-button'),
        starMenuBtn: box('.sl-menu-button'),
        hasSidebar: document.documentElement.hasAttribute('data-has-sidebar'),
      };
    });
    console.log(`${name}\t${width}\t${JSON.stringify(data)}`);
    await page.screenshot({
      path: `${outDir}/${name}-${width}.png`,
      clip: { x: 0, y: 0, width, height: 72 },
    });
    await ctx.close();
  }
}

await browser.close();
