/** PNG 像素统计（无依赖）：解 IDAT + 去 filter，输出透明占比与白/黑/绿/其他分布 */
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2 && colorType !== 3)) {
    return { error: `unsupported png: depth=${bitDepth} color=${colorType}` };
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  // 统计（调色板：索引 → PLTE RGB + tRNS alpha）
  let opaque = 0;
  const total = width * height;
  const buckets = { white: 0, black: 0, green: 0, other: 0 };
  const at = (i) => {
    if (colorType === 3) {
      const idx = out[i];
      const off = idx * 3;
      return [palette[off], palette[off + 1], palette[off + 2], trns ? (trns[idx] ?? 255) : 255];
    }
    return [out[i * bpp], out[i * bpp + 1], out[i * bpp + 2], bpp === 4 ? out[i * bpp + 3] : 255];
  };
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a] = at(i);
    if (a <= 16) continue;
    opaque++;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > 220) buckets.white++;
    else if (lum < 60) buckets.black++;
    else if (g > 140 && g > r * 1.3 && g > b * 1.2) buckets.green++;
    else buckets.other++;
  }
  return {
    size: `${width}x${height}`,
    opaquePct: Math.round((opaque / total) * 100) + '%',
    dist: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [k, Math.round((v / Math.max(opaque, 1)) * 100) + '%']),
    ),
  };
}

for (const f of process.argv.slice(2)) {
  console.log(f, JSON.stringify(decodePNG(f)));
}
