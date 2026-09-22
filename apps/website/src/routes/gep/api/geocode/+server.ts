// Proxies God's Eye Politics address lookups to the Census Geocoder (no CORS).
// Mirrors the ledger /api/* proxy pattern; served under /gep/api/geocode.
// This is static-file-serving + one relay: near-zero server cost.
import { error } from '@sveltejs/kit';

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/geographies/address'
	+ '?benchmark=Public_AR_Current&vintage=Current_Current&format=json';

export async function GET({ url }) {
	const street = url.searchParams.get('street') || '';
	const city = url.searchParams.get('city') || '';
	if (!street) return error(400, 'street required');
	const target = `${CENSUS}&street=${encodeURIComponent(street)}&city=${encodeURIComponent(city)}&state=FL`;
	try {
		const r = await fetch(target, {
			headers: { 'User-Agent': 'leftydevkit/gep/1.0' },
			signal: AbortSignal.timeout(20000),
		});
		const data = await r.json();
		const matches = data?.result?.addressMatches || [];
		const out = { input: { street, city }, reps: {} };
		if (matches.length) {
			const m = matches[0];
			out.coords = m.coordinates;
			for (const items of Object.values(m.geographies || {})) {
				for (const it of items) {
					const name = String(it.NAME || '');
					const num = name.split(' ').pop();
					if (name.startsWith('State House District')) out.reps.house = num;
					else if (name.startsWith('State Senate District')) out.reps.senate = num;
					else if (name.startsWith('Congressional District')) out.reps.congressional = num;
				}
			}
		}
		return new Response(JSON.stringify(out), {
			status: 200,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	} catch (e) {
		return error(502, String(e.message || e));
	}
}