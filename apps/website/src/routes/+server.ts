// Serves the LeftyDevKit 3D landing site at the site root.
// The 3D page is a self-contained HTML document (its own <html>/<head>/<style>),
// so it's served raw here instead of through the SvelteKit layout.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Locate 3d-home.html in both dev (static/) and prod (adapter-node build/client/).
function findHome(): string {
  const candidates = [
    path.resolve(process.cwd(), 'static', '3d-home.html'),   // dev / source
    path.resolve(process.cwd(), 'client', '3d-home.html'),   // prod (adapter-node runs in build/)
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/3d-home.html'),
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch {}
  }
  // Last resort: read from the module dir upwards.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = path.resolve(dir, '3d-home.html');
    try { readFileSync(p); return p; } catch {}
    dir = path.dirname(dir);
  }
  throw new Error('3d-home.html not found');
}

const HOME = readFileSync(findHome(), 'utf8');

export function GET() {
  return new Response(HOME, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' }
  });
}
