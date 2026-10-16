// Serve a built game under /<prefix>/ with the prefix stripped, exactly like the games gateway
// (Caddy handle_path): /<prefix> redirects to /<prefix>/, and any request outside the prefix is a
// logged 404, so root-absolute URLs show up at once.
//   node tools/serve-prefixed.mjs <dir> <prefix> <port>     (npm run preview:path)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const [root, prefix, port] = [process.argv[2], '/' + process.argv[3], Number(process.argv[4])];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === prefix) { res.writeHead(308, { Location: prefix + '/' }); return res.end(); }
  if (!url.pathname.startsWith(prefix + '/')) { console.log('OUTSIDE PREFIX', url.pathname); res.writeHead(404); return res.end('outside prefix'); }
  let p = decodeURIComponent(url.pathname.slice(prefix.length));
  if (p.endsWith('/')) p += 'index.html';
  const file = join(root, normalize(p));
  try {
    if (!(await stat(file)).isFile()) throw 0;
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { console.log('404', url.pathname); res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}${prefix}/`));
