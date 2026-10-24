/**
 * 页脚几何探针 + 截图（手工验收用，不进 npm run check）
 *
 * 量：页脚横带、菜单网格、各分组标题的 top/left、版权条边界，并与上方正文
 * （.sl-container / .markdown）左右边界对比 —— 判定三件事：
 *   ① 横带通栏、带内文字与正文同级居中（首列左缘 = 正文左缘）；
 *   ② 同一行的分组标题在一条水平线上（宽屏两行、窄屏按列填）；
 *   ③ 每个分组在当前列宽内等宽（1fr），无横向溢出。
 * 顺带核对：首页不该再有「编辑此页」。
 *
 * 用法：BASE_URL=... PAGES=zh-cn/,en/ WIDTHS=1440,1180,820,420 node scripts/footer-probe.mjs [outDir]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4321/agent-bridge';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outDir = process.argv[2] ?? 'scripts/footer-shots';
mkdirSync(outDir, { recursive: true });

const PAGES = (process.env.PAGES ?? 'zh-cn/,en/').split(',');
const WIDTHS = (process.env.WIDTHS ?? '1440,1180,820,420')
  .split(',')
  .map((w) => Number(w.trim()));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const pagePath of PAGES) {
  for (const width of WIDTHS) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/${pagePath}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);

      const geo = await page.evaluate(() => {
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            l: Math.round(r.left),
            r: Math.round(r.right),
            t: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
          };
        };
        const one = (sel) => box(document.querySelector(sel));
        const groups = [...document.querySelectorAll('.ab-footer-group')].map((g) => ({
          title: g.querySelector('.ab-footer-title')?.textContent?.trim() ?? '',
          box: box(g),
          titleBox: box(g.querySelector('.ab-footer-title')),
        }));
        const nav = document.querySelector('.ab-footer-nav');
        return {
          vw: window.innerWidth,
          content: one('main .content-panel:last-of-type .sl-container'),
          markdown: one('.sl-markdown-content'),
          band: one('.ab-footer-band'),
          nav: box(nav),
          colCount: nav ? getComputedStyle(nav).gridTemplateColumns.split(' ').length : 0,
          legal: one('.ab-footer-copy'),
          groups,
          editLink: Boolean(document.querySelector('a[href*="/edit/"]')),
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
        };
      });

      // 逐行判定：同 top 的标题归为一行
      const rows = new Map();
      for (const g of geo.groups) {
        if (!g.titleBox) continue;
        const k = g.titleBox.t;
        rows.set(k, [...(rows.get(k) ?? []), g.title]);
      }
      const rowInfo = [...rows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, titles]) => `y=${t} [${titles.join(' | ')}]`);

      // 两端对齐 + 间距口径：
      //   6 列（一行态）→ 相邻列盒之间的空隙必须相等（justify-content: space-between 均分）；
      //   3 列（两行态）→ 中间列盒中心 = 内容区中心；
      //   2 列（≤320）→ 只判左右贴边。
      // 贴边判定取所有列盒的极值 —— 两列模式下右列首项不是 DOM 里的第 2 项，按索引取会误判。
      const c = geo.content;
      const boxes = geo.groups.map((g) => g.box).filter(Boolean);
      const flushLeft = Boolean(c && boxes.length && Math.abs(Math.min(...boxes.map((b) => b.l)) - c.l) <= 1);
      const flushRight = Boolean(c && boxes.length && Math.abs(Math.max(...boxes.map((b) => b.r)) - c.r) <= 1);

      let spacing = null;
      if (geo.colCount === 6 && boxes.length === 6) {
        const gaps = boxes.slice(1).map((b, i) => b.l - boxes[i].r);
        spacing = { label: '间隙均分', ok: Math.max(...gaps) - Math.min(...gaps) <= 1, detail: gaps.join('/') };
      } else if (geo.colCount === 3) {
        const mid = geo.groups[1]?.box;
        spacing = {
          label: '中间居中',
          ok: Boolean(mid && c && Math.abs((mid.l + mid.r) / 2 - (c.l + c.r) / 2) <= 1),
          detail: '',
        };
      }

      const f = (b) =>
        b ? `${String(b.l).padStart(4)}..${String(b.r).padStart(4)} w${String(b.w).padStart(4)}` : '    ——        ';
      const tag = `${pagePath.replace(/\//g, '-').replace(/-+$/, '') || 'root'}-${width}-${scheme}`;
      const mark = (b) => (b === null ? 'n/a' : b ? 'OK' : 'FAIL');

      const spacingMark = spacing ? `${spacing.label}=${mark(spacing.ok)}` : '间距口径=n/a';
      console.log(
        `\n[${tag}] vw=${geo.vw} 溢出=${geo.overflowX} 编辑此页=${geo.editLink ? '有' : '无'}` +
          ` 列数=${geo.colCount} 左贴边=${mark(flushLeft)} 右贴边=${mark(flushRight)} ${spacingMark}` +
          (spacing?.detail ? ` (${spacing.detail})` : ''),
      );
      console.log(`  容器     ${f(geo.content)}   正文 ${f(geo.markdown)}   横带 ${f(geo.band)}`);
      console.log(`  菜单     ${f(geo.nav)}   版权行 ${f(geo.legal)}`);
      console.log(`  分组标题行数=${rows.size}  ${geo.groups.length} 组`);
      for (const r of rowInfo) console.log(`    ${r}`);
      console.log(
        `    列盒 ${geo.groups.map((g) => `${g.title}:${g.box.l}..${g.box.r}`).join('  ')}`,
      );

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${outDir}/${tag}.png` });
      await ctx.close();
    }
  }
}

await browser.close();
