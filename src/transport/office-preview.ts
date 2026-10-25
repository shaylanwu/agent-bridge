import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Office 文件内容预览（本地解析，不上传第三方服务）。
 * 仅提取可读内容：docx 段落、xlsx 工作表、pptx 幻灯片文本。
 * 不是完整 Office 排版引擎；目的是让结果文件无需下载也能快速阅读。
 */

function zipEntries(file: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocd = (() => {
    for (let i = file.length - 22; i >= Math.max(0, file.length - 65557); i -= 1) {
      if (file.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) throw new Error('invalid zip');
  const centralOffset = file.readUInt32LE(eocd + 16);
  const count = file.readUInt16LE(eocd + 10);
  let cursor = centralOffset;
  for (let i = 0; i < count && cursor + 46 <= file.length; i += 1) {
    if (file.readUInt32LE(cursor) !== 0x02014b50) break;
    const compression = file.readUInt16LE(cursor + 10);
    const compressedSize = file.readUInt32LE(cursor + 20);
    const nameLength = file.readUInt16LE(cursor + 28);
    const extraLength = file.readUInt16LE(cursor + 30);
    const commentLength = file.readUInt16LE(cursor + 32);
    const localOffset = file.readUInt32LE(cursor + 42);
    const name = file.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = file.readUInt16LE(localOffset + 26);
    const localExtraLength = file.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = file.subarray(dataStart, dataStart + compressedSize);
    if (compression === 0) entries.set(name, compressed);
    else if (compression === 8) entries.set(name, inflateRawSync(compressed));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function textOfXml(xml: string, tag: string): string {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))]
    .map((m) => decodeXml((m[1] ?? '').replace(/<[^>]+>/g, '')))
    .join('');
}

function paragraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const text = textOfXml(p[1] ?? '', 'w:t');
    if (text.trim()) out.push(text);
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(0, n - 1);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function officeHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#243447;padding:24px;max-width:980px;margin:auto}
  h1{font-size:20px;margin:0 0 18px}h2{font-size:15px;margin:22px 0 8px;color:#3b506b}
  p{margin:7px 0;white-space:pre-wrap}table{border-collapse:collapse;width:100%;font-size:12px}
  td,th{border:1px solid #dce4ee;padding:6px 8px;text-align:left;white-space:pre-wrap}th{background:#f2f6fa}
  .slide{border:1px solid #e0e7ef;border-radius:10px;padding:14px;margin:12px 0;background:#fafcfd}
  </style></head><body>${body}</body></html>`;
}

function renderXlsx(files: Map<string, Buffer>): string {
  const workbook = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (!workbook) return '';
  const relMap = new Map<string, string>();
  if (rels) {
    for (const m of rels.toString('utf8').matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap.set(m[1] ?? '', m[2] ?? '');
  }
  const shared = files.get('xl/sharedStrings.xml');
  const sharedStrings = shared ? [...shared.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOfXml(m[1] ?? '', 't')) : [];
  const sheets: string[] = [];
  for (const sheet of workbook.toString('utf8').matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relMap.get(sheet[2] ?? '') || `worksheets/sheet${sheets.length + 1}.xml`;
    const xml = files.get(`xl/${target.replace(/^\//, '')}`)?.toString('utf8');
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1] ?? '';
        const ref = (attrs.match(/r="([A-Z]+)\d+"/i) || [])[1] || 'A';
        const idx = columnIndex(ref);
        const type = (attrs.match(/t="([^"]+)"/) || [])[1];
        let value = '';
        if (type === 'inlineStr') value = textOfXml(cell[2] ?? '', 't');
        else {
          const raw = textOfXml(cell[2] ?? '', 'v');
          value = type === 's' ? sharedStrings[Number(raw)] || raw : raw;
        }
        cells[idx] = value;
      }
      rows.push(`<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`);
    }
    sheets.push(`<h2>${escapeHtml(sheet[1] ?? '')}</h2><table>${rows.slice(0, 100).join('')}</table>`);
  }
  return sheets.join('');
}

function renderPptx(files: Map<string, Buffer>): string {
  const slides = [...files.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return slides.map((name, i) => {
    const xml = files.get(name)!.toString('utf8');
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => textOfXml(p[1] ?? '', 'a:t')).filter((t) => t.trim());
    return `<div class="slide"><h2>幻灯片 ${i + 1}</h2>${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>`;
  }).join('');
}

export function renderOfficePreview(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (!['.docx', '.xlsx', '.pptx'].includes(ext)) return null;
  const files = zipEntries(readFileSync(path));
  if (ext === '.docx') {
    const xml = files.get('word/document.xml')?.toString('utf8') || '';
    return `<h1>Word 文档</h1>${paragraphs(xml).map((p) => `<p>${escapeHtml(p)}</p>`).join('') || '<p>（未提取到文本）</p>'}`;
  }
  if (ext === '.xlsx') return `<h1>Excel 工作簿</h1>${renderXlsx(files)}`;
  return `<h1>PowerPoint 演示文稿</h1>${renderPptx(files)}`;
}

export const OFFICE_MIME_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
