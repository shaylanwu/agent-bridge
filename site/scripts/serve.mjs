/**
 * 本地预览服务器（替代 astro preview）：
 *  - `/agent-bridge/*` 映射到 dist/*（base 镜像）；
 *  - `/` 与 `/agent-bridge`（不带尾斜杠）→ dist/index.html（语言协商重定向页）；
 *  - 其余按静态文件服务。
 * 这样裸根路径 http://127.0.0.1:4321/ 也能进站（astro preview 对带 base 的站点，裸根永远 404）。
 * 部署（GitHub Pages）不受影响——那边的根路径本来就是 /agent-bridge/。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const dist = join(siteRoot, 'dist');
const PORT = Number(process.env.PORT ?? 4321);
const BASE = '/agent-bridge';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 把 URL 解析成 dist 内的文件路径；解析失败返回 null（交给重定向页） */
function resolveFile(urlPath) {
  // 1) 站点入口（不带 base、带 base 无尾斜杠、裸根）
  if (urlPath === '/' || urlPath === BASE || urlPath === `${BASE}/`) {
    return join(dist, 'index.html');
  }
  // 2) base 镜像：/agent-bridge/xxx → dist/xxx
  let p = urlPath;
  if (p === BASE) p = `${BASE}/`;
  if (p.startsWith(`${BASE}/`)) {
    p = p.slice(BASE.length); // → /xxx
    let file = normalize(join(dist, decodeURIComponent(p)));
    if (!file.startsWith(dist)) return null;
    return file;
  }
  // 3) 其他（favicon 等）：按 dist 根解析
  return normalize(join(dist, decodeURIComponent(urlPath)));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let file = resolveFile(url.pathname);

    let statInfo = null;
    try {
      statInfo = await stat(file);
    } catch {
      /* 不存在 */
    }
    // 目录 → 尝试 index.html
    if (statInfo?.isDirectory()) {
      file = join(file, 'index.html');
      try {
        statInfo = await stat(file);
      } catch {
        statInfo = null;
      }
    }
    // 文件不存在 → 回退语言协商入口页（比裸 404 友好）
    if (!statInfo?.isFile()) {
      file = join(dist, 'index.html');
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(`preview error: ${e.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/  （站点入口 /${BASE}/ 也已可用）`);
});
