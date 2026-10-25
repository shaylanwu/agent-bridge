import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderOfficePreview } from '../src/transport/office-preview';

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(centralBuffer.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuffer, end]);
}

describe('Office 内容预览', () => {
  it('docx：提取文档段落文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-office-'));
    writeFileSync(join(dir, 'a.docx'), zip({ 'word/document.xml': '<w:document><w:body><w:p><w:t>Hello</w:t></w:p><w:p><w:t>World</w:t></w:p></w:body></w:document>' }));
    expect(renderOfficePreview(join(dir, 'a.docx'))).toContain('Hello');
    expect(renderOfficePreview(join(dir, 'a.docx'))).toContain('World');
  });

  it('xlsx：解析工作表与共享字符串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-office-'));
    writeFileSync(join(dir, 'a.xlsx'), zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Agent</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    }));
    const html = renderOfficePreview(join(dir, 'a.xlsx')) || '';
    expect(html).toContain('Sheet1');
    expect(html).toContain('Agent');
    expect(html).toContain('42');
  });

  it('pptx：提取幻灯片文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-office-'));
    writeFileSync(join(dir, 'a.pptx'), zip({ 'ppt/slides/slide1.xml': '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Demo Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' }));
    expect(renderOfficePreview(join(dir, 'a.pptx'))).toContain('Demo Slide');
  });
});
