<!-- Corruption Ledger hero widget for the LeftyDevKit website.

Drop into apps/website/src/routes/+page.svelte inside the .hero container,
just under the hero-buttons div. Reads the live API with a build-time fallback
so the number is never blank if the tracker is down.

Set PUBLIC_LEDGER_API in the site env to the deployed tracker origin. -->
<script lang="ts">
  // Fallback = last known verified standing. Updated by `python -m tracker.export`.
  const FALLBACK = {
    combined: 3336410000, flow_to_trump: 2166710000, cost_to_public: 1169700000,
    incidents: 44, citations: 66, since: '2025-01-16'
  };
  const API = import.meta.env.PUBLIC_LEDGER_API ?? '';
  const TOOL = '/ledger';

  let d = $state(FALLBACK);
  let shown = $state(0);

  $effect(() => {
    if (!API) { rollTo(d.combined); return; }
    fetch(API + '/api/hero')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => { d = { ...FALLBACK, ...j }; rollTo(d.combined); })
      .catch(() => rollTo(d.combined));
  });

  function rollTo(target: number) {
    const t0 = performance.now(), dur = 1400;
    const step = (t: number) => {
      const p = Math.min((t - t0) / dur, 1);
      shown = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const usd = (n: number) => '$' + n.toLocaleString('en-US');
  const short = (n: number) =>
    n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' :
    n >= 1e6 ? '$' + (n / 1e6).toFixed(0) + 'M' : '$' + n.toLocaleString();
</script>

<a class="ledger" href={TOOL}>
  <div class="label">Documented corruption, this administration</div>
  <div class="number">{usd(shown)}</div>
  <div class="split">
    <span class="flow"><b>{short(d.flow_to_trump)}</b> to Trump &amp; family</span>
    <span class="dot">·</span>
    <span class="pub"><b>{short(d.cost_to_public)}</b> public money</span>
  </div>
  <div class="foot">
    {d.incidents} verified incidents · {d.citations} citations · since {d.since}
    <span class="cta">Open the ledger →</span>
  </div>
</a>

<style>
  .ledger {
    display: block; text-decoration: none; color: inherit;
    margin-top: 2rem; padding: 1.25rem 1.5rem; max-width: 620px;
    background: rgba(10, 20, 40, .55);
    border: 1px solid rgba(90, 155, 255, .28);
    border-left: 3px solid #2f6feb;
    border-radius: 14px; backdrop-filter: blur(6px);
    transition: border-color .2s, transform .2s;
  }
  .ledger:hover { border-color: rgba(90,155,255,.7); transform: translateY(-2px); }
  .label {
    font-size: .74rem; text-transform: uppercase; letter-spacing: .11em;
    color: #8fa3c4; margin-bottom: .3rem;
  }
  .number {
    font-size: clamp(2.3rem, 6vw, 3.4rem); font-weight: 800; line-height: 1;
    letter-spacing: -1.5px; font-variant-numeric: tabular-nums; color: #fff;
  }
  .split { margin-top: .55rem; font-size: .93rem; color: #c3cfe6; }
  .split .flow b { color: #5a9bff; }
  .split .pub b { color: #f0a341; }
  .dot { color: #4a5b78; margin: 0 .4rem; }
  .foot {
    margin-top: .6rem; font-size: .78rem; color: #8fa3c4;
    display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
  }
  .cta { color: #5a9bff; font-weight: 600; }
</style>
