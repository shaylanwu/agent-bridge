/**
 * 版面几何探针：量「顶栏内容容器 / 左栏 / 中栏 / 右栏 / 正文」这几条关键边界线，
 * 用来验收「顶栏与正文容器同宽、左右栏等宽、中栏吃剩余」这条口径。
 *
 * 用法：BASE_URL=... node scripts/layout-probe.mjs [outDir]
 * 输出每档视口一行的边界表（x 坐标四舍五入到 1px），并用 `ok` 标记四条不变式。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4399/agent-bridge';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = process.argv[2] ?? 'scripts/layout-shots';
mkdirSync(outDir, { recursive: true });

const WIDTHS = (process.env.WIDTHS ?? '1600,1440,1360,1280,1180,1000')
  .split(',')
  .map((w) => Number(w.trim()));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rows = [];

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/zh-cn/api/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const geo = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
    };
    const shell = document.querySelector('.header-shell');
    const shellCs = shell ? getComputedStyle(shell) : null;
    return {
      vw: window.innerWidth,
      headerShell: box('.header-shell'),
      headerPadX: shellCs ? shellCs.paddingInlineStart : null,
      logo: box('.title-wrapper img, .title-wrapper a'),
      sidebarPane: box('.sidebar-pane'),
      sidebarContent: box('.sidebar-content'),
      sidebarFirstLink: box('.sidebar-content a, .sidebar-content .large'),
      mainFrame: box('.main-frame'),
      mainPane: box('.main-pane'),
      rightContainer: box('.right-sidebar-container'),
      rightAside: box('.right-sidebar'),
      tocPanel: box('.right-sidebar-panel'),
      tocContainer: box('.right-sidebar-panel .sl-container'),
      tocFirst: box('.right-sidebar-panel .sl-container > :first-child'),
      contentPanel: box('main .content-panel:last-of-type'),
      markdown: box('.sl-markdown-content'),
      h1: box('main h1'),
      sidebarH1: box('.sidebar-content .large'),
    };
  });

  const h = geo.headerShell;
  const s = geo.sidebarPane;
  const rc = geo.rightContainer;
  // 三栏只在 ≥72rem 成立；更窄时右栏退化成顶部「本页内容」折叠条，不做等宽比较
  const threeCol = geo.vw >= 1152;
  const checks = {
    headerEqBody: h && s && rc ? Math.abs(h.l - s.l) <= 1 && Math.abs(h.r - rc.r) <= 1 : false,
    sidebarsEqual: threeCol && s && rc ? Math.abs(s.w - rc.w) <= 1 : null,
    middlePositive: rc && s ? rc.l - s.r > 0 : false,
  };
  rows.push({ width, geo, checks });
  await page.screenshot({ path: `${outDir}/layout-${width}.png` });
  await ctx.close();
}

for (const { width, geo, checks } of rows) {
  const f = (b) => (b ? `${String(b.l).padStart(4)}..${String(b.r).padStart(4)} w${String(b.w).padStart(4)}` : '   ——        ');
  console.log(`\n[${width}px] vw=${geo.vw}  ${checks.headerEqBody ? 'OK' : 'FAIL'}:顶栏=正文容器  ${checks.sidebarsEqual === null ? 'n/a(单栏)' : checks.sidebarsEqual ? 'OK:左右栏等宽' : 'FAIL:左右栏等宽'}`);
  console.log(`  顶栏内容 ${f(geo.headerShell)}  padX=${geo.headerPadX}   logo ${f(geo.logo)}`);
  console.log(`  左栏     ${f(geo.sidebarPane)}   左栏分组字 ${f(geo.sidebarFirstLink)}`);
  console.log(`  中栏正文 ${f(geo.markdown)}   h1 ${f(geo.h1)}`);
  console.log(`  右栏     ${f(geo.rightContainer)}  目录列 ${f(geo.tocContainer)}  首行 ${f(geo.tocFirst)}`);
}

await browser.close();
