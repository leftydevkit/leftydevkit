// Proxies /api/* to the Corruption Ledger tracker (Flask).
// The tracker owns the DB + daily scout; the SvelteKit app is the public face.
// Server-to-server, so no CORS concerns. Set TRACKER_ORIGIN to the tracker base.
import { error } from '@sveltejs/kit';

const ORIGIN = process.env.TRACKER_ORIGIN || process.env.PUBLIC_LEDGER_API || 'http://127.0.0.1:8000';

export async function GET({ params, url }) {
  const target = `${ORIGIN}/api/${params.path || ''}${url.search}`;
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(15000) });
    const body = await r.arrayBuffer();
    return new Response(body, {
      status: r.status,
      headers: {
        'content-type': r.headers.get('content-type') || 'application/json',
        'cache-control': 'public, max-age=60'
      }
    });
  } catch (e) {
    return error(502, 'ledger tracker unreachable');
  }
}
