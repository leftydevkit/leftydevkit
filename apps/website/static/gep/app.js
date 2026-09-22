/* God's Eye Politics — FL organizing console
 * Views: DISTRICTS (members+committees) / MARGINS '22 (choropleth, house|senate) /
 *        COUNTY SHIFT (2018->2022 governor Dem% trend) / MONEY (FEC congressional)
 * Target Board: every state district ranked by flip/defend priority from 2022 margins.
 * Intel panel: member contact info, committees, sponsored bills, money, call/email
 *              script, verdict. Address lookup: /api/geocode (serve.py proxy -> Census).
 */

const DATA = {
  districts:     '/gep/data/build/districts.geojson',
  congressional: '/gep/data/build/congressional.geojson',
  counties:      '/gep/data/build/counties.geojson',
  bills:         '/gep/data/build/bills.json',
  money:         '/gep/data/build/money.json',
  members:       '/gep/data/build/members.json',
  contacts:      '/gep/data/build/contacts.json',
  elections:     '/gep/data/build/elections.json',
  openstates:    '/gep/data/build/openstates.json',
  fec:           '/gep/data/build/fec.json',
};

// API root. Standalone serve.py exposes /api/geocode; the leftydevkit
// embed rewrites this to /gep/api/geocode via a small page-level override.
const API_BASE = window.GEP_API_BASE || '/api';

const STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'osm-dark': {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#070a12' } },
    { id: 'osm-dark', type: 'raster', source: 'osm-dark',
      paint: { 'raster-opacity': 0.5, 'raster-brightness-max': 0.55, 'raster-saturation': -0.7 } },
  ],
};
let geo, congGeo, countyGeo;
let bills = [], money = [], members = [], contacts = {}, elections = {};
let openstates = { members: {}, bills: [] };
let fec = { candidates: [] };
let map;
let view = 'districts';           // districts | margins | shift | money
let chamber = 'house';            // for margins view
let congById = {};

// diverging color scale: Dem blue <- R red (dem_share 0..100)
function marginColor(share) {
  // share = dem % of two-party vote; 50 = white-ish midpoint
  const stops = [[0,'#b2182b'],[20,'#ef8a62'],[40,'#fddbc7'],[47,'#f7f7f7'],[53,'#d1e5f0'],[60,'#67a9cf'],[80,'#2166ac'],[100,'#053061']];
  for (let i = 0; i < stops.length - 1; i++) {
    if (share <= stops[i+1][0]) {
      const [a, ca] = stops[i], [b, cb] = stops[i+1];
      const t = (share - a) / (b - a || 1);
      return lerpColor(ca, cb, t);
    }
  }
  return stops[stops.length-1][1];
}
function lerpColor(c1, c2, t) {
  const p = c => [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)];
  const [r1,g1,b1] = p(c1), [r2,g2,b2] = p(c2);
  const h = v => Math.round(v).toString(16).padStart(2,'0');
  return `#${h(r1+(r2-r1)*t)}${h(g1+(g2-g1)*t)}${h(b1+(b2-b1)*t)}`;
}
function shiftColor(s) { // positive = shifted Dem; amplify so ±8pt saturates
  if (s == null) return '#22304a';
  return marginColor(50 + Math.max(-20, Math.min(20, s * 2.5)));
}

// ---- boot ----
function init() {
  map = new maplibregl.Map({
    container: 'map', style: STYLE, center: [-82.0, 28.3], zoom: 6.0,
    minZoom: 5.4, maxZoom: 12, attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  window.__map = map;
  map.on('load', () => {
    map.addSource('districts', { type: 'geojson', data: geo });
    map.addSource('counties', { type: 'geojson', data: countyGeo });
    map.addSource('congressional', { type: 'geojson', data: congGeo });
    map.addSource('money', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('mymarker', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // base district layers
    map.addLayer({ id: 'district-fill', type: 'fill', source: 'districts',
      paint: { 'fill-color': '#12233a', 'fill-opacity': ['case', ['==', ['get','chamber'], chamber], 0.35, 0.06] } });
    map.addLayer({ id: 'district-line', type: 'line', source: 'districts',
      paint: { 'line-color': '#5a7bb0', 'line-width': ['case', ['==', ['get','chamber'], chamber], 1.1, 0.35],
               'line-opacity': ['case', ['==', ['get','chamber'], chamber], 0.95, 0.3] } });
    // margins choropleth (per-district dem share, join by chamber+district)
    map.addLayer({ id: 'margin-fill', type: 'fill', source: 'districts', layout: { visibility: 'none' },
      paint: { 'fill-color': ['coalesce', ['get', 'demshare'], '#0d1524'], 'fill-opacity': 0.85 },
      filter: ['==', ['get', 'chamber'], chamber] });
    map.addLayer({ id: 'margin-line', type: 'line', source: 'districts', layout: { visibility: 'none' },
      paint: { 'line-color': '#0a0f1a', 'line-width': 0.8 }, filter: ['==', ['get','chamber'], chamber] });
    // county shift
    map.addLayer({ id: 'county-fill', type: 'fill', source: 'counties', layout: { visibility: 'none' },
      paint: { 'fill-color': ['coalesce', ['get', 'shiftcolor'], '#22304a'], 'fill-opacity': 0.85 } });
    map.addLayer({ id: 'county-line', type: 'line', source: 'counties', layout: { visibility: 'none' },
      paint: { 'line-color': '#0a0f1a', 'line-width': 0.7 } });
    // money pins + CD lines
    map.addLayer({ id: 'cd-line', type: 'line', source: 'congressional', layout: { visibility: 'none' },
      paint: { 'line-color': '#4a5f8a', 'line-width': 0.8, 'line-opacity': 0.7 } });
    map.addLayer({ id: 'money-pin', type: 'circle', source: 'money', layout: { visibility: 'none' },
      paint: { 'circle-color': '#ffb454', 'circle-radius': ['interpolate', ['linear'], ['get','total'], 0, 3, 1000000, 16],
               'circle-opacity': 0.9, 'circle-stroke-color': '#0b111c', 'circle-stroke-width': 1 } });
    // my-location marker
    map.addLayer({ id: 'me', type: 'circle', source: 'mymarker',
      paint: { 'circle-color': '#35e0d5', 'circle-radius': 7, 'circle-stroke-color': '#04121a', 'circle-stroke-width': 2 } });

    map.on('click', 'district-fill', e => openFocus(e.features[0].properties));
    map.on('click', 'margin-fill', e => openFocus(e.features[0].properties));
    map.on('click', 'money-pin', e => openMoney(e.features[0].properties));
    ['district-fill', 'margin-fill', 'money-pin'].forEach(l => {
      map.on('mouseenter', l, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', l, () => map.getCanvas().style.cursor = '');
    });
    map.on('click', e => {
      if (!map.queryRenderedFeatures(e.point, { layers: ['district-fill', 'margin-fill', 'money-pin'] }).length) closeFocus();
    });

    applyView();
    buildTargetBoard();
    const osB = (openstates.bills || []).length;
    const xmlB = bills.length;
    const billLabel = osB ? `${osB} BILLS '25` : `${xmlB} BILLS '24`;
    setStatus(`DATABASE ONLINE · ${billLabel} · ${members.length} MEMBERS · ${(fec.candidates || []).length} FEC CANDIDATES · 2022 MARGINS`);
  });
}

async function loadAll() {
  const j = u => fetch(u).then(r => r.ok ? r.json() : null).catch(() => null);
  const [d, cg, co, b, mo, me, ct, el, os, fc] = await Promise.all([
    j(DATA.districts), j(DATA.congressional), j(DATA.counties), j(DATA.bills),
    j(DATA.money), j(DATA.members), j(DATA.contacts), j(DATA.elections),
    j(DATA.openstates), j(DATA.fec),
  ]);
  geo = d; congGeo = cg; countyGeo = co;
  bills = Array.isArray(b) ? b : []; money = Array.isArray(mo) ? mo : [];
  members = Array.isArray(me) ? me : []; contacts = ct || {};
  elections = el || { districts: {}, counties: {} };
  openstates = os || { members: {}, bills: [] };
  fec = fc || { candidates: [] };
  (congGeo && congGeo.features || []).forEach(f => { congById[String(f.properties.district).replace(/^0+/,'')] = f; });

  // Merge OpenStates data into contacts (emails for both chambers, committees)
  Object.entries(openstates.members || {}).forEach(([key, osm]) => {
    if (!contacts[key]) contacts[key] = {};
    const c = contacts[key];
    if (osm.email && !c.email) c.email = osm.email;
    if (osm.phones && osm.phones.length && !c.district_phone) c.district_phone = osm.phones[0];
    if (osm.committees && osm.committees.length && !c.committees) c.committees = osm.committees;
    if (osm.offices && osm.offices.length && !c.office) {
      const dist = osm.offices.find(o => o.classification === 'district') || osm.offices[0];
      c.office = dist.address || null;
    }
    if (osm.openstates_url) c.openstates_url = osm.openstates_url;
  });

  // join election margins + contact info onto district features (client-side enrich)
  const ed = elections.districts || {};
  (geo.features || []).forEach(f => {
    const key = f.properties.chamber + ':' + String(f.properties.district).replace(/^0+/,'');
    const e = ed[key];
    if (e) { f.properties.demshare = e.dem_share; f.properties.margin = e.margin_pct; f.properties.margincolor = marginColor(e.dem_share ?? 50); }
    const c = contacts[key];
    if (c) Object.assign(f.properties, { cname: c.name, cparty: c.party, cemail: c.email, cphone: c.district_phone || c.phone, ccapitol: c.capitol_phone, coffice: c.office, ccommittees: (c.committees || []).join(' | '), curl: c.contact_url });
  });
  (countyGeo && countyGeo.features || []).forEach(f => { f.properties.shiftcolor = shiftColor(f.properties.shift); });

  // money pins at CD centroids — use FEC per-candidate data when available
  const fecByCD = {};
  (fec.candidates || []).forEach(c => {
    if (c.office === 'H' && c.district != null && c.receipts != null) {
      const cd = String(c.district).replace(/^0+/,'');
      if (!fecByCD[cd]) fecByCD[cd] = [];
      fecByCD[cd].push(c);
    }
  });
  const cdNums = Object.keys(fecByCD).length ? Object.keys(fecByCD) : Object.keys(congById);
  const feats = cdNums.map(cd => {
    const f = congById[cd];
    const pt = f && centroid(f);
    if (!pt) return null;
    const cands = fecByCD[cd] || [];
    const total = cands.reduce((s, c) => s + (parseFloat(c.receipts) || 0), 0);
    const top = [...cands].sort((a, b) => (parseFloat(b.receipts) || 0) - (parseFloat(a.receipts) || 0))[0];
    return { type: 'Feature', properties: { district: cd, total, candidates: cands.length, top: top ? top.name : null, source: 'fec' }, geometry: { type: 'Point', coordinates: pt } };
  }).filter(Boolean);
  MONEY_FEATURES = feats;
}
let MONEY_FEATURES = [];

function centroid(f) {
  const c = f.geometry.coordinates;
  let ring;
  if (f.geometry.type === 'Polygon') ring = c[0];
  else if (f.geometry.type === 'MultiPolygon') ring = c[0] && c[0][0];
  else return null;
  if (!ring || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  for (const p of ring) { x += p[0]; y += p[1]; n++; }
  return [x/n, y/n];
}

// ---- views ----
function applyView() {
  const vis = (l, on) => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
  const v = view;
  // district lines are always visible as an overlay
  vis('district-fill', v === 'districts');
  vis('district-line', true);
  vis('margin-fill', v === 'margins');
  vis('margin-line', v === 'margins');
  vis('county-fill', v === 'shift');
  vis('county-line', v === 'shift');
  vis('cd-line', v === 'money');
  vis('money-pin', v === 'money');
  if (v === 'margins') {
    map.setFilter('margin-fill', ['==', ['get', 'chamber'], chamber]);
    map.setFilter('margin-line', ['==', ['get', 'chamber'], chamber]);
    // recolor via feature-state-free approach: bake color per chamber into paint expression
    map.setPaintProperty('margin-fill', 'fill-color',
      ['case', ['has', 'margincolor'], ['get', 'margincolor'], '#0d1524']);
  }
  if (v === 'money') map.getSource('money').setData({ type: 'FeatureCollection', features: MONEY_FEATURES });
  document.getElementById('chamber').style.display = v === 'margins' ? 'flex' : 'none';
  document.querySelectorAll('#views .view-tab').forEach(t => t.classList.toggle('on', t.dataset.view === v));
  renderLegend();
  renderBoardList();
}

function renderLegend() {
  const el = document.getElementById('legend-body');
  const t = document.getElementById('legend-title');
  if (view === 'districts') {
    t.textContent = 'DISTRICT CHAMBERS';
    el.innerHTML = `<div class="row"><span class="sw" style="background:#1a2f4d"></span>${chamber === 'house' ? 'House (active)' : 'Senate (active)'}</div>
      <div class="row"><span class="sw" style="background:#0d1826;opacity:.5"></span>other chamber</div>
      <div class="row" style="margin-top:8px;color:var(--dim);font-size:10px">CLICK A DISTRICT → MEMBER INTEL + ACTIONS</div>`;
  } else if (view === 'margins') {
    t.textContent = `2022 DEM % · ${chamber.toUpperCase()}`;
    el.innerHTML = `<div class="bar"></div><div class="barlabels"><span>0 R</span><span>50</span><span>100 D</span></div>
      <div class="row" style="margin-top:8px;color:var(--dim);font-size:10px">MARGIN = (D−R)/TOTAL · SOURCE: OPENELECTIONS PRECINCTS</div>`;
  } else if (view === 'shift') {
    t.textContent = 'COUNTY SHIFT 2018→2022';
    el.innerHTML = `<div class="bar"></div><div class="barlabels"><span>−20 R</span><span>0</span><span>+20 D</span></div>
      <div class="row" style="margin-top:8px;color:var(--dim);font-size:10px">GOVERNOR RACE · DEM % OF TWO-PARTY VOTE, 2018 → 2022</div>`;
  } else {
    t.textContent = 'FEC MONEY (CONGRESSIONAL)';
    el.innerHTML = `<div class="row"><span class="sw" style="background:#ffb454;border-radius:50%"></span>candidate receipts 2024 (size = $)</div>
      <div class="row"><span class="sw" style="background:#4a5f8a"></span>CD boundaries</div>`;
  }
}

// ---- target board ----
function districtPriority() {
  const out = [];
  (geo.features || []).forEach(f => {
    const p = f.properties;
    if (!p || p.demshare == null) return;
    const dem = p.demshare;
    const held = p.cparty === 'D';
    let kind, score;
    if (held) { kind = dem < 55 ? 'defend' : 'safe'; score = dem < 55 ? (55 - dem) : 0; }
    else if (dem > 45) { kind = 'dem'; score = dem - 45; }          // R-held within reach
    else { kind = dem > 42 ? 'watch' : 'deep'; score = dem > 42 ? (dem - 42) : 0; }
    out.push({ chamber: p.chamber, district: String(p.district).replace(/^0+/,''), demshare: dem,
               margin: p.margin, name: p.cname, party: p.cparty, kind, score, pt: centroid(f) });
  });
  return out;
}

function buildTargetBoard() { buildTargetBoardCache = districtPriority(); renderBoardList(); }
let buildTargetBoardCache = [];

function renderBoardList() {
  const list = document.getElementById('blist');
  let items = buildTargetBoardCache.filter(d => view === 'margins' ? d.chamber === chamber : true);
  // priority: defend (vulnerable D) + dem (reachable R) first, by score desc
  const rank = { defend: 3, dem: 2, watch: 1, safe: 0, deep: 0 };
  items = items.filter(d => rank[d.kind] > 0).sort((a, b) => rank[b.kind] - rank[a.kind] || b.score - a.score).slice(0, 40);
  const desc = document.getElementById('board-desc');
  desc.textContent = view === 'margins'
    ? `${chamber.toUpperCase()} targets, 2022 margins. DEFEND = vulnerable Dem seats · blue = reachable R seats.`
    : 'All chambers. DEFEND = Dem seats under 55% · blue = R seats within 5pts.';
  list.innerHTML = items.map((d, i) => {
    const chip = d.kind === 'defend' ? '<span class="chip defend">DEFEND</span>' :
                 d.kind === 'dem' ? '<span class="chip flip">FLIP</span>' : '';
    const cls = d.kind === 'defend' ? 'held' : d.kind === 'dem' ? 'flippable' : 'dem';
    return `<div class="trow" data-ch="${d.chamber}" data-d="${d.district}">
      <span class="rank">${i+1}</span>
      <span class="info"><span class="n">${d.name || 'DISTRICT ' + d.district} ${chip}</span>
      <span class="d">${d.chamber} ${d.district} · ${d.party || '?'} · D${d.demshare}%</span></span>
      <span class="marg ${cls}">${d.margin > 0 ? '+' : ''}${d.margin}</span></div>`;
  }).join('') || '<div style="color:var(--dim);padding:10px;font-size:11px">No targets in this view.</div>';
  list.querySelectorAll('.trow').forEach(r => r.addEventListener('click', () => {
    const f = geo.features.find(g => g.properties.chamber === r.dataset.ch &&
      String(g.properties.district).replace(/^0+/,'') === r.dataset.d);
    if (f) { openFocus(f.properties); if (f.properties.pt || true) flyToDistrict(f); }
  }));
}

function flyToDistrict(f) {
  const pt = centroid(f);
  if (pt) map.flyTo({ center: pt, zoom: Math.max(map.getZoom(), 7.4), speed: 1.6 });
}

// ---- intel panel ----
function openFocus(p) {
  const chamberN = p.chamber || 'house';
  const d = String(p.district).replace(/^0+/,'');
  const key = chamberN + ':' + d;
  const c = contacts[key];
  const bs = bills.filter(b => (b.chamber || '') === chamberN && String(b.district || '').replace(/^0+/,'') === d);
  const member = members.find(m => m.chamber === chamberN && String(m.district) === d) || {};
  const e = (elections.districts || {})[key];

  const name = (c && c.name) || member.name || `DISTRICT ${d}`;
  const party = (c && c.party) || (member.party === 'Republican' ? 'R' : member.party === 'Democratic' ? 'D' : '?');
  document.getElementById('f-title').textContent = `${name} · ${party}`;
  document.getElementById('f-sub').textContent = `FL ${chamberN.toUpperCase()} DISTRICT ${d}`;

  let html = '';
  // verdict
  if (e) {
    const dem = e.dem_share;
    let v, cls;
    if (party === 'D') { v = dem < 55 ? `⚠ DEFEND — ${dem}% Dem in 2022, winnable by opposition` : `SAFE — ${dem}% Dem in 2022`; cls = dem < 55 ? 'defend' : 'safe'; }
    else if (dem > 45) { v = `⚑ FLIP TARGET — ${dem}% Dem in 2022, within reach (${e.margin_pct > 0 ? '+' : ''}${e.margin_pct}pt margin)`; cls = 'target'; }
    else if (dem > 42) { v = `WATCH — ${dem}% Dem in 2022; build base before ${2026}`; cls = 'defend'; }
    else { v = `DEEP R — ${dem}% Dem in 2022; long-term organizing`; cls = 'safe'; }
    html += `<div class="verdict ${cls}">${v}</div>`;
  }
  // KPIs
  html += `<div class="kpi">
    <div class="box"><div class="n">${e ? e.dem_share + '%' : '—'}</div><div class="l">Dem '22</div></div>
    <div class="box"><div class="n">${e ? (e.margin_pct > 0 ? '+' : '') + e.margin_pct : '—'}</div><div class="l">Margin</div></div>
    <div class="box"><div class="n">${bs.length}</div><div class="l">Bills</div></div>
  </div>`;
  // contact
  html += '<h4 class="act">CONTACT / TAKE ACTION</h4><div class="contact">';
  if (c && c.district_phone) html += `<a href="tel:${c.district_phone.replace(/[^\d]/g,'')}">📞 ${c.district_phone}</a>`;
  if (c && c.capitol_phone) html += `<a href="tel:${c.capitol_phone.replace(/[^\d]/g,'')}">🏛 ${c.capitol_phone}</a>`;
  if (c && c.email) html += `<a href="mailto:${c.email}">✉ ${c.email}</a>`;
  if (c && c.contact_url) html += `<a href="${c.contact_url}" target="_blank" rel="noopener">🔗 official page</a>`;
  if (!c) html += '<span style="color:var(--dim)">no contact record</span>';
  html += '</div>';
  if (c && c.office) html += `<div style="font-size:10px;color:var(--dim);margin-top:6px">District office: ${c.office}</div>`;
  // script
  const last = (name.split(',')[0] || name).replace('Senator ', '');
  html += `<div class="script" id="callsheet">Hi, I'm a constituent in ${chamberN.toUpperCase()} District ${d}. I'm calling about [ISSUE/BILL]. ${party === 'R' ? `I want to know where ${last} stands on [ISSUE], and I'd like a response.` : `Thank you for your work on [ISSUE] — please keep fighting for it.`} Can you confirm ${last}'s position and note my call?` +
    (c && c.email ? `\n\nEMAIL TEMPLATE:\nSubject: Constituent in District ${d} — action on [ISSUE]\nDear ${last}, …[your story, 2 sentences]… Please [specific ask]. Sincerely, [name, address — proves constituency]` : '') + '</div>';
  // committees
  if (c && c.committees && c.committees.length) {
    html += '<h4>COMMITTEE ASSIGNMENTS</h4><ul>' + c.committees.slice(0, 10).map(x => `<li>${x}</li>`).join('') + '</ul>';
  }
  // bills — 2025 session from OpenStates (current), fallback to 2024 XML
  const osBills = (openstates.bills || []).filter(b =>
    b.sponsor_district != null && String(b.sponsor_district).replace(/^0+/,'') === d &&
    (b.chamber || '') === chamberN);
  html += `<h4>BILLS SPONSORED (${openstates.session || '2025'} SESSION)</h4>`;
  if (osBills.length) {
    [...osBills].sort((a, b) => String(a.number).localeCompare(String(b.number))).slice(0, 12).forEach(b => {
      html += `<li><span style="color:var(--amber);font-weight:700">${b.number || '?'}</span> <span style="color:var(--dim)">${b.title || ''}</span>${b.status ? `<div style="color:#5a6a85;font-size:10px;padding-left:14px">${b.status}</div>` : ''}${b.url ? `<div style="padding-left:14px"><a href="${b.url}" target="_blank" rel="noopener" style="color:var(--cyan);font-size:10px">track on OpenStates →</a></div>` : ''}</li>`;
    });
  } else if (bs.length) {
    [...bs].sort((a, b) => String(a.bill_number).localeCompare(String(b.bill_number))).slice(0, 12).forEach(b => {
      html += `<li><span style="color:var(--amber);font-weight:700">${b.bill_number || '?'}</span> <span style="color:var(--dim)">${b.title || ''}</span>${b.status ? `<div style="color:#5a6a85;font-size:10px;padding-left:14px">${b.status}</div>` : ''}</li>`;
    });
  } else {
    html += `<div style="color:var(--dim);font-size:11px">No bills found for this member in the ${openstates.session || '2025'} session.</div>`;
  }
  // FEC finance (per-candidate, not just CD-level)
  const cd = cdForDistrict(p);
  let fecCands;
  if (chamberN === 'house') {
    // House: match by overlapping congressional district
    fecCands = (fec.candidates || []).filter(c =>
      c.office === 'H' && cd && String(c.district || '').replace(/^0+/,'') === cd && c.receipts != null);
  } else {
    // Senate: statewide, match all FL Senate candidates
    fecCands = (fec.candidates || []).filter(c =>
      c.office === 'S' && c.receipts != null);
  }
  html += '<h4 class="money">CAMPAIGN FINANCE (FEC 2024)</h4>';
  fecCands = [...fecCands].sort((a, b) => (parseFloat(b.receipts) || 0) - (parseFloat(a.receipts) || 0)).slice(0, 6);
  if (fecCands.length) {
    fecCands.forEach(c => {
      html += `<li><b>${c.name || '?'}</b> <span style="color:var(--amber)">$${fmt(parseFloat(c.receipts) || 0)}</span> raised · <span style="color:var(--dim)">$${fmt(parseFloat(c.cash_on_hand) || 0)} cash</span>`;
      if (c.top_donors && c.top_donors.length) {
        html += '<div style="padding-left:14px;font-size:10px;color:var(--dim)">Top donors: ' +
          c.top_donors.slice(0, 3).map(dn => `${dn.name} ($${fmt(parseFloat(dn.amount) || 0)})`).join(' · ') + '</div>';
      }
      html += '</li>';
    });
  } else {
    // Fallback to old CD-level money
    let ms = money.filter(m => String(m.district || '').replace(/^0+/,'') === cd);
    if (ms.length) {
      [...ms].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 6).forEach(m => {
        html += `<li><b>${m.spender || '?'}</b> <span style="color:var(--amber)">$${fmt(m.amount || 0)}</span> <span style="color:var(--dim)">· ${m.owner || ''}</span></li>`;
      });
    } else {
      html += '<div style="color:var(--dim);font-size:11px">No FEC data for this district.</div>';
    }
  }

  document.getElementById('f-body').innerHTML = html;
  document.getElementById('focus').style.display = 'flex';
}

function cdForDistrict(p) {
  const f = geo.features.find(g => g.properties.chamber === p.chamber && String(g.properties.district).replace(/^0+/,'') === String(p.district).replace(/^0+/,''));
  const pt = f && centroid(f);
  if (!pt) return '';
  const cd = (congGeo && congGeo.features || []).find(x => pointInPoly(pt, x));
  return cd ? String(cd.properties.district).replace(/^0+/,'') : '';
}

function openMoney(m) {
  document.getElementById('f-title').textContent = `FL-${m.district} · FEDERAL MONEY`;
  document.getElementById('f-sub').textContent = m.source === 'fec' ? 'FEC 2024 CYCLE · PER-CANDIDATE' : 'FEC BULK CSV';
  const cands = (fec.candidates || []).filter(c =>
    c.office === 'H' && String(c.district || '').replace(/^0+/,'') === String(m.district).replace(/^0+/,'') && c.receipts != null);
  if (cands.length) {
    const total = cands.reduce((s, c) => s + (parseFloat(c.receipts) || 0), 0);
    let html = `<div class="kpi"><div class="box"><div class="n">$${fmt(total)}</div><div class="l">CD TOTAL</div></div><div class="box"><div class="n">${cands.length}</div><div class="l">CANDIDATES</div></div></div>`;
    html += '<h4 class="money">ALL CANDIDATES · FL-' + m.district + '</h4><ul>';
    [...cands].sort((a, b) => (parseFloat(b.receipts) || 0) - (parseFloat(a.receipts) || 0)).forEach(x => {
      html += `<li><b>${x.name || '?'}</b> <span style="color:var(--amber)">$${fmt(parseFloat(x.receipts) || 0)}</span> <span style="color:var(--dim)">· ${x.party || '?'} · ${x.incumbent_challenge || ''}</span>`;
      if (x.top_donors && x.top_donors.length) {
        html += '<div style="padding-left:14px;font-size:10px;color:var(--dim)">Top: ' +
          x.top_donors.slice(0, 3).map(dn => `${dn.name} ($${fmt(parseFloat(dn.amount) || 0)})`).join(' · ') + '</div>';
      }
      html += '</li>';
    });
    html += '</ul>';
    document.getElementById('f-body').innerHTML = html;
  } else {
    // Fallback to old bulk CSV money
    const ms = money.filter(x => String(x.district || '').replace(/^0+/,'') === String(m.district).replace(/^0+/,''));
    document.getElementById('f-body').innerHTML = `<div class="kpi"><div class="box"><div class="n">$${fmt(ms.reduce((s, x) => s + (x.amount || 0), 0))}</div><div class="l">CD TOTAL</div></div><div class="box"><div class="n">${ms.length}</div><div class="l">CANDIDATES</div></div></div>
      <h4 class="money">ALL CANDIDATES · FL-${m.district}</h4><ul>` +
      [...ms].sort((a, b) => (b.amount || 0) - (a.amount || 0)).map(x =>
        `<li><b>${x.spender}</b> <span style="color:var(--amber)">$${fmt(x.amount || 0)}</span> <span style="color:var(--dim)">· ${x.owner || ''}</span></li>`).join('') + '</ul>';
  }
  document.getElementById('focus').style.display = 'flex';
}

function closeFocus() { document.getElementById('focus').style.display = 'none'; }
function fmt(n) { if (n >= 1e6) return (n/1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n/1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
function setStatus(t) { document.getElementById('status').textContent = t; }
function pointInPoly(pt, f) {
  const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
  return polys.some(poly => {
    const ring = poly[0]; let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  });
}

// ---- view / chamber tabs ----
document.querySelectorAll('#views .view-tab').forEach(t => t.addEventListener('click', () => { view = t.dataset.view; applyView(); }));
document.querySelectorAll('#chamber .view-tab').forEach(t => t.addEventListener('click', () => {
  chamber = t.dataset.ch;
  document.querySelectorAll('#chamber .view-tab').forEach(x => x.classList.toggle('on', x === t));
  if (view !== 'margins') { view = 'margins'; }
  applyView();
}));

// ---- address lookup: my reps ----
const addrEl = document.getElementById('addr'), findBtn = document.getElementById('findbtn');
async function findReps() {
  const raw = addrEl.value.trim();
  if (!raw) return;
  findBtn.disabled = true; setStatus('GEOCODING…');
  let [street, city] = [raw, ''];
  const m = raw.match(/^(.*?),\s*(.+)$/);
  if (m) { street = m[1]; city = m[2]; }
  try {
    const r = await fetch(API_BASE + '/geocode?street=' + encodeURIComponent(street) + '&city=' + encodeURIComponent(city));
    const g = await r.json();
    if (g.error) throw new Error(g.error);
    if (!g.reps || !g.reps.house) { setStatus('NO FL MATCH — USE "STREET, CITY"'); return; }
    if (g.coords) map.getSource('mymarker').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [g.coords.x, g.coords.y] } }] });
    setStatus(`YOUR REPS · HOUSE ${g.reps.house} · SENATE ${g.reps.senate || '?'} · CD ${g.reps.congressional || '?'}`);
    const key = 'house:' + String(g.reps.house).replace(/^0+/,'');
    const f = geo.features.find(x => x.properties.chamber === 'house' && String(x.properties.district).replace(/^0+/,'') === String(g.reps.house).replace(/^0+/,''));
    if (f) { openFocus(f.properties); flyToDistrict(f); }
  } catch (e) {
    setStatus('GEOCODE FAILED: ' + e.message + ' (run via serve.py, not http.server)');
  } finally { findBtn.disabled = false; }
}
findBtn.addEventListener('click', findReps);
addrEl.addEventListener('keydown', e => { if (e.key === 'Enter') findReps(); });

// ---- boot ----
(async function boot() {
  setStatus('LOADING DATA…');
  await loadAll();
  init();
})();
