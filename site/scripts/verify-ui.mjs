/**
 * 用真实浏览器读取首页关键元素的计算样式 + DOM 结构，并输出全页截图。
 * 只读不改；截图存 scripts/ui-shot.png 供人工核对。
 */
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:4321/agent-bridge/zh-cn/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(() => {
  const cs = (el, props) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = s.getPropertyValue(p);
    return out;
  };
  const r = (el) => (el ? el.getBoundingClientRect() : null);

  const features = document.querySelector('.home-features');
  const cols = [...document.querySelectorAll('.home-feature')];
  const paths = document.querySelector('.home-paths');
  const cards = [...document.querySelectorAll('.home-path')];
  const h1 = document.querySelector('.hero h1');

  return {
    h1: cs(h1, ['white-space', 'font-size', 'line-height', 'max-width', 'font-weight']),
    features: cs(features, ['display', 'grid-template-columns', 'align-items']),
    cols: cols.map((c) => ({
      style: cs(c, ['display', 'flex-direction', 'align-items', 'margin-top']),
      rect: { top: Math.round(r(c).top), height: Math.round(r(c).height) },
    })),
    paths: cs(paths, ['display', 'grid-template-columns', 'align-items']),
    cards: cards.map((c) => ({
      style: cs(c, ['display', 'flex-direction', 'background-color']),
      rect: { top: Math.round(r(c).top), height: Math.round(r(c).height, ), bottom: Math.round(r(c).bottom) },
    })),
    cardP: cs(document.querySelector('.home-path p'), ['flex-grow', 'margin-top']),
    cardA: cs(document.querySelector('.home-path a'), ['margin-top', 'align-self']),
    domSnippet: {
      featuresChildren: cols.map((c) => c.outerHTML.slice(0, 60)),
      pathsChildren: cards.map((c) => c.outerHTML.slice(0, 60)),
      betweenFigureAndFeatures:
        document.querySelector('.home-figure')?.nextElementSibling?.className ?? null,
    },
    loadedCss: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) =>
      l.getAttribute('href'),
    ),
  };
});

console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: 'scripts/ui-shot.png', fullPage: true });
console.log('\n[screenshot] scripts/ui-shot.png');
await browser.close();
