/**
 * 顶栏垂直对齐探针：测量 logo / 搜索 / 菜单按钮的垂直中心，以及移动菜单页脚布局。
 * 用法：BASE_URL=... node scripts/header-align-probe.mjs [outDir]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321/agent-bridge';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = process.argv[2] ?? 'scripts/header-shots/prod';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const pages = [
  ['home', `${BASE}/zh-cn/`],
  ['api', `${BASE}/zh-cn/api/`],
  ['api-ref', `${BASE}/zh-cn/api/reference/`],
  ['doc', `${BASE}/zh-cn/quickstart/`],
];

for (const [name, url] of pages) {
  for (const width of [440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => {
      const mid = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), cy: Math.round(r.top + r.height / 2), h: Math.round(r.height), w: Math.round(r.width) };
      };
      const header = document.querySelector('header.header');
      const cs = getComputedStyle(header);
      const logo = document.querySelector('.title-wrapper img') ?? document.querySelector('.title-wrapper a');
      const searchSvg = document.querySelector('site-search button[data-open-modal] svg');
      const searchBtn = document.querySelector('site-search button[data-open-modal]');
      const menuBtn = document.querySelector('.sl-menu-button') ?? document.querySelector('.ab-menu-btn');
      return {
        navHeight: cs.getPropertyValue('--sl-nav-height').trim(),
        navPadY: cs.getPropertyValue('--sl-nav-pad-y').trim(),
        headerH: Math.round(header.getBoundingClientRect().height),
        logo: mid(logo),
        searchBtn: mid(searchBtn),
        searchSvg: mid(searchSvg),
        menuBtn: mid(menuBtn),
        menuRadius: menuBtn ? getComputedStyle(menuBtn).borderRadius : null,
        menuBg: menuBtn ? getComputedStyle(menuBtn).backgroundColor : null,
      };
    });

    // 打开菜单，检查页脚
    const btn = await page.$('.sl-menu-button') ?? await page.$('.ab-menu-btn');
    let footer = null;
    if (btn) {
      await btn.click();
      await page.waitForTimeout(400);
      footer = await page.evaluate(() => {
        const el = document.querySelector('.mobile-preferences') ?? document.querySelector('.ab-mobile-extras');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const kids = [...el.children].map((k) => {
          const kr = k.getBoundingClientRect();
          return { tag: k.tagName.toLowerCase(), cls: k.className, x: Math.round(kr.x), w: Math.round(kr.width) };
        });
        return {
          cls: el.className,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          justify: cs.justifyContent,
          gap: cs.gap,
          borderTop: cs.borderTopWidth + ' ' + cs.borderTopColor,
          padding: cs.padding,
          kids,
        };
      });
      await page.screenshot({ path: `${outDir}/menu-${name}-${width}.png` });
    }

    console.log(name, width, JSON.stringify({ header: before, footer }));
    await ctx.close();
  }
}

await browser.close();
