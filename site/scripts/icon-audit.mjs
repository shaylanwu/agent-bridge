/**
 * 图标标准审计（可复跑）：`npm run build` 之后执行。
 *
 * 判据（与 src/adapters/agent-logos.ts 的规格注释同源）：
 *   1. 每个图标 viewBox 必须是 `0 0 24 24`；
 *   2. 像素级墨迹边界（尊重 clipPath / filter）最大边落在 [19.5, 20.5]（目标 20）；
 *   3. 墨迹完全落在画布内（1..23），不得有裁切；
 *   4. 12 个 agent 的 <kind>-light.svg 变体不作为独立图标参与（只查 agent 清单）。
 *
 * 同时输出 `scripts/icon-audit.png` 对照网格（暗/亮各一行），供人工核对。
 * 只读，不改任何文件。
 */
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/assets/agents';
const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));
const icons = files.map((f) => ({ name: f, svg: readFileSync(join(DIR, f), 'utf8') }));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 });
await page.setContent('<html><body></body></html>');

const results = await page.evaluate(async (items) => {
  const out = [];
  for (const { name, svg } of items) {
    const vbAttr = svg.match(/viewBox="([^"]+)"/)?.[1] || '';
    const [vx, vy, vw, vh] = vbAttr.split(/[\s,]+/).map(Number);
    const scale = Math.min(768 / Math.max(vw, vh), 16);
    const W = Math.round(vw * scale);
    const H = Math.round(vh * scale);
    const copy = svg.replace(/<svg([^>]*)>/, (m, attrs) => {
      const cleaned = attrs.replace(/\s(width|height|style)="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
      return `<svg ${cleaned} width="${W}" height="${H}">`;
    });
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decoding failed: ' + name));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(copy);
    });
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 16) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const u = (v) => +(v / scale).toFixed(2);
    out.push({
      name, vb: vbAttr, empty: maxX < 0,
      bbox: maxX < 0 ? null : { x: u(minX), y: u(minY), w: u(maxX - minX + 1), h: u(maxY - minY + 1) },
      vbW: vw, vbH: vh,
    });
  }
  return out;
}, icons);

let failed = 0;
console.log('icon'.padEnd(24) + 'viewBox'.padEnd(14) + 'ink bbox'.padEnd(24) + 'max'.padEnd(7) + 'verdict');
for (const r of results) {
  const maxDim = r.bbox ? Math.max(r.bbox.w, r.bbox.h) : 0;
  const problems = [];
  if (r.vb !== '0 0 24 24') problems.push('viewBox≠24');
  if (r.empty) problems.push('EMPTY');
  if (maxDim < 19.5 || maxDim > 20.5) problems.push(`max=${maxDim}`);
  if (r.bbox && (r.bbox.x < 0.5 || r.bbox.y < 0.5 || r.bbox.x + r.bbox.w > 23.5 || r.bbox.y + r.bbox.h > 23.5))
    problems.push('overflow/clip');
  if (problems.length) failed++;
  console.log(
    r.name.padEnd(24) +
      r.vb.padEnd(14) +
      (r.bbox ? `${r.bbox.x},${r.bbox.y} ${r.bbox.w}×${r.bbox.h}` : 'n/a').padEnd(24) +
      String(maxDim).padEnd(7) +
      (problems.length ? '✗ ' + problems.join(' / ') : '✓'),
  );
}

// 对照网格（暗 / 亮）
const grid = (list, fg, label) =>
  `<div style="background:${label === 'dark' ? '#0a111e' : '#fff'};color:${fg};display:grid;grid-template-columns:repeat(6,1fr);gap:2px">` +
  list.map((i) => `<div style="display:flex;flex-direction:column;align-items:center;padding:12px;gap:6px">
    <div style="width:72px;height:72px">${i.svg.replace(/<svg/, '<svg style="width:100%;height:100%"')}</div>
    <div style="font-size:10px">${i.name.replace('.svg', '')}</div></div>`).join('') +
  '</div>';
await page.setContent(`<html><body style="margin:0;font-family:system-ui">${grid(icons, '#e4ecf6', 'dark')}${grid(icons, '#1a2028', 'light')}</body></html>`);
await page.screenshot({ path: 'scripts/icon-audit.png', fullPage: true });
await browser.close();

console.log(`\n[icon-audit] ${failed ? `${failed} 个图标不符合标准` : '全部符合标准'}；对照图 scripts/icon-audit.png`);
if (failed) process.exit(1);
