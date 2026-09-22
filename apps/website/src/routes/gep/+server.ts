// Serves the God's Eye Politics app at /gep.
// The app is a self-contained HTML document (own <html>/<head>/<style> + relative
// app.js/data/), served raw — same approach as the 3D landing page at /.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findGep(): string {
	const candidates = [
		path.resolve(process.cwd(), 'static', 'gep', 'index.html'), // dev / source
		path.resolve(process.cwd(), 'client', 'gep', 'index.html'), // prod (adapter-node build/client/)
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/gep/index.html'),
	];
	for (const c of candidates) {
		try { readFileSync(c); return c; } catch {}
	}
	throw new Error('static/gep/index.html not found');
}

const GEP = readFileSync(findGep(), 'utf8');

export function GET() {
	return new Response(GEP, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
	});
}