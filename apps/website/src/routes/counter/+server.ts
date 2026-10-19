// Serves the transparent stream-counter overlay at /counter.
// Same pattern as the root +server.ts: the page is a self-contained HTML
// document, so it is returned raw instead of through the SvelteKit layout.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'counter.html';

function findPage(): string {
  const candidates = [
    path.resolve(process.cwd(), 'static', NAME),   // dev / source
    path.resolve(process.cwd(), 'client', NAME),   // prod (adapter-node runs in build/)
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client', NAME),
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch {}
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = path.resolve(dir, NAME);
    try { readFileSync(p); return p; } catch {}
    dir = path.dirname(dir);
  }
  throw new Error(NAME + ' not found');
}

const PAGE_PATH = findPage();

export function GET() {
  const html = readFileSync(PAGE_PATH, 'utf8');
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' }
  });
}
