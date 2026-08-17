<script lang="ts">
	import { onMount } from 'svelte';

	type Citation = { url: string; publisher?: string; title?: string; tier?: number };
	type Incident = {
		id: number; slug: string; title: string; summary?: string; date?: string;
		category?: string; status: 'verified' | 'unverified';
		confidence?: number; flow_to_trump: number; cost_to_public: number;
		deal_value?: number; amount_basis?: string; is_estimated?: boolean;
		citations?: Citation[];
	};
	type LedgerData = {
		generated_at?: string;
		counter: {
			verified_incidents: number; unverified_pending: number;
			total_flow_to_trump: number; total_cost_to_public: number;
			documented_deal_value: number; first_date?: string; last_date?: string;
			citation_count: number;
		};
		by_category?: Record<string, number>;
		incidents: Incident[];
	};

	const API = import.meta.env.PUBLIC_LEDGER_API ?? '';

	// Bundled snapshot = instant render even if tracker is down. Live API refreshes it.
	let data = $state<LedgerData>({
		counter: {
			verified_incidents: 44, unverified_pending: 71,
			total_flow_to_trump: 2166710000, total_cost_to_public: 1169700000,
			documented_deal_value: 567416100000, first_date: '2025-01-16',
			last_date: '2026-06-30', citation_count: 66
		},
		by_category: {}, incidents: []
	});
	let live = $state(false);

	onMount(async () => {
		try {
			const r = await fetch('/data/ledger.json');
			if (r.ok) { const j = await r.json(); if (j?.incidents) data = j; }
		} catch { /* fallback stands */ }

		if (API) {
			try {
				const s = await (await fetch(API + '/api/stats')).json();
				const inc = await (await fetch(API + '/api/incidents?limit=500')).json();
				if (s?.combined && inc?.incidents) {
					data = {
						counter: {
							verified_incidents: s.verified_incidents,
							unverified_pending: s.unverified_pending,
							total_flow_to_trump: s.flow_to_trump,
							total_cost_to_public: s.cost_to_public,
							documented_deal_value: s.documented_deal_value,
							first_date: s.first_date, last_date: s.last_date,
							citation_count: s.citation_count
						},
						by_category: s.by_category,
						incidents: inc.incidents
					};
					live = true;
				}
			} catch { /* keep snapshot */ }
		}
	});

	// ---- derived state ----
	let q = $state('');
	let cat = $state('all');
	let ledger = $state('all');
	let sort = $state('amount');
	let show = $state('verified');

	const combined = $derived((data.counter.total_flow_to_trump || 0) + (data.counter.total_cost_to_public || 0));
	const cats = $derived(
		Object.keys(data.by_category ?? {}).sort((a, b) => (data.by_category?.[b] ?? 0) - (data.by_category?.[a] ?? 0))
	);
	const catsFromInc = $derived(
		[...new Set(data.incidents.map(i => i.category).filter(Boolean))].sort()
	);

	const filtered = $derived.by(() => {
		let list = data.incidents;
		if (show === 'verified') list = list.filter(i => i.status === 'verified');
		if (show === 'unverified') list = list.filter(i => i.status === 'unverified');
		if (cat !== 'all') list = list.filter(i => i.category === cat);
		if (ledger === 'flow') list = list.filter(i => (i.flow_to_trump || 0) > 0);
		if (ledger === 'public') list = list.filter(i => (i.cost_to_public || 0) > 0);
		if (ledger === 'money') list = list.filter(i => (i.flow_to_trump || 0) > 0 || (i.cost_to_public || 0) > 0);
		if (q.trim()) {
			const s = q.trim().toLowerCase();
			list = list.filter(i =>
				(i.title || '').toLowerCase().includes(s) ||
				(i.summary || '').toLowerCase().includes(s) ||
				(i.category || '').toLowerCase().includes(s)
			);
		}
		const amt = (i: Incident) => Math.max(i.flow_to_trump || 0, i.cost_to_public || 0, i.deal_value || 0);
		list = [...list];
		if (sort === 'amount') list.sort((a, b) => amt(b) - amt(a));
		else if (sort === 'date') list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
		else if (sort === 'date_asc') list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
		else if (sort === 'confidence') list.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
		return list;
	});

	const shownCount = $derived(filtered.length);

	// ---- helpers ----
	const money = (n: number) => !n ? '$0' :
		n >= 1e9 ? '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B' :
		n >= 1e6 ? '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' :
		n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toLocaleString();
	const fullMoney = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
	const pct = (n: number) => combined ? Math.round((n / combined) * 100) : 0;
	const fmtDate = (d?: string) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'undated';
	const catLabel = (c?: string) => ({ contracts: 'Contracts', crypto: 'Crypto', selfdeal: 'Self-dealing', emoluments: 'Foreign gifts', oversight: 'Oversight', pardons: 'Pardons', appointments: 'Appointments', propaganda: 'Propaganda', other: 'Other', unclassified: 'Unclassified' }[c ?? ''] ?? c ?? 'Other');
</script>

<svelte:head>
	<title>Corruption Ledger — LeftyDevKit</title>
	<meta name="description" content="Every documented corruption incident of the current administration — cited, dated, and separated into honest ledgers. Built by LeftyDevKit." />
</svelte:head>

<section class="ledger-hero">
	<div class="container">
		<p class="eyebrow"><span class="live-dot"></span> {live ? 'Live data' : 'Data snapshot'} · documented corruption</p>
		<h1>The Corruption <span>Ledger</span></h1>
		<p class="sub">
			Every incident is cited, dated, and separated into honest ledgers — money that reached
			the president's family is tracked apart from public money steered to third parties.
			<strong>No vibes. Show your source.</strong>
		</p>

		<div class="hero-stats">
			<div class="stat total">
				<span class="k">Documented total</span>
				<span class="v">{fullMoney(combined)}</span>
				<span class="n">across {data.counter.verified_incidents} verified incidents</span>
			</div>
			<div class="stat flow">
				<span class="k">To Trump &amp; family</span>
				<span class="v">{money(data.counter.total_flow_to_trump)}</span>
				<span class="n">Money that landed with them ({pct(data.counter.total_flow_to_trump)}%)</span>
			</div>
			<div class="stat public">
				<span class="k">Public money</span>
				<span class="v">{money(data.counter.total_cost_to_public)}</span>
				<span class="n">Taxpayer dollars committed ({pct(data.counter.total_cost_to_public)}%)</span>
			</div>
		</div>

		<div class="bar">
			<i class="f" style="width:{pct(data.counter.total_flow_to_trump)}%"></i>
			<i class="p" style="width:{pct(data.counter.total_cost_to_public)}%"></i>
		</div>
		<p class="bar-note">
			{data.counter.citation_count} citations · since {fmtDate(data.counter.first_date)} ·{' '}
			{data.counter.unverified_pending} more awaiting verification · context deals worth {money(data.counter.documented_deal_value)} kept separate
		</p>
	</div>
</section>

<section class="ledger-method">
	<div class="container">
		<h2>How to read this</h2>
		<div class="method-grid">
			<div class="m-card flow">
				<h3>To Trump &amp; family</h3>
				<p>Dollars that demonstrably landed with the president, his family, or their companies. Preferred evidence is his <em>own</em> federal financial disclosure.</p>
			</div>
			<div class="m-card public">
				<h3>Public money</h3>
				<p>Taxpayer dollars committed or misdirected to third parties — no-bid contracts, diverted funds, loans. The family benefit may be indirect.</p>
			</div>
			<div class="m-card context">
				<h3>Context (kept separate)</h3>
				<p>Deal sizes, proposed-but-blocked funds, and campaign donations that never reached Trump personally. Shown for scale, <strong>never added to the headline</strong>.</p>
			</div>
		</div>
		<div class="proof">
			📄 <strong>Tier 0</strong> badges mark primary government documents — including Trump's own OGE filings. Every incident carries at least one citation you can click and check.
		</div>
	</div>
</section>

<section class="ledger-list">
	<div class="container">
		<div class="controls">
			<input type="search" placeholder="Search incidents, people, companies…" bind:value={q} />
			<select bind:value={cat}>
				<option value="all">All categories</option>
				{#each (cats.length ? cats : catsFromInc) as c}
					<option value={c}>{catLabel(c)}</option>
				{/each}
			</select>
			<select bind:value={ledger}>
				<option value="all">All incidents</option>
				<option value="money">Has a dollar figure</option>
				<option value="flow">Money to Trump</option>
				<option value="public">Public money</option>
			</select>
			<select bind:value={sort}>
				<option value="amount">Biggest first</option>
				<option value="date">Newest first</option>
				<option value="date_asc">Oldest first</option>
				<option value="confidence">Most confident</option>
			</select>
			<select bind:value={show}>
				<option value="verified">Verified only</option>
				<option value="all">All</option>
				<option value="unverified">Unverified queue</option>
			</select>
		</div>

		<p class="count">{shownCount} incident{shownCount === 1 ? '' : 's'}{q.trim() ? ` matching “${q.trim()}”` : ''}</p>

		{#if filtered.length === 0}
			<div class="empty">No incidents match.</div>
		{:else}
			<div class="cards">
				{#each filtered as i (i.id)}
					<article class="inc" class:has-money={(i.flow_to_trump || 0) > 0 || (i.cost_to_public || 0) > 0}>
						<div class="inc-head">
							<h3>{i.title}</h3>
							{#if (i.flow_to_trump || 0) > 0 || (i.cost_to_public || 0) > 0}
								<span class="amt">
									{#if (i.flow_to_trump || 0) > 0}<span class="f">{money(i.flow_to_trump)} to Trump</span>{/if}
									{#if (i.cost_to_public || 0) > 0}<span class="p">{money(i.cost_to_public)} public</span>{/if}
								</span>
							{/if}
						</div>
						<div class="meta">
							<span class="tag">{catLabel(i.category)}</span>
							<span class="date">{fmtDate(i.date)}</span>
							{#if i.confidence}<span class="conf">confidence {i.confidence}%</span>{/if}
							{#if i.is_estimated}<span class="est">estimated</span>{/if}
							{#if i.status !== 'verified'}<span class="tag unv">unverified</span>{/if}
						</div>
						{#if i.summary}<p class="sum">{i.summary}</p>{/if}
						{#if i.amount_basis}
							<div class="basis"><strong>Basis:</strong> {i.amount_basis}</div>
						{/if}
						{#if i.citations?.length}
							<div class="cites">
								{#each i.citations as c}
									<a href={c.url} target="_blank" rel="noopener" class="cite" class:t0={c.tier === 0}>
										{#if c.tier === 0}📄 {/if}{c.publisher ?? 'source'}
									</a>
								{/each}
							</div>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	</div>
</section>

<style>
	.ledger-hero {
		padding: 72px 0 48px;
		text-align: center;
		background:
			radial-gradient(1200px 400px at 50% -50px, rgba(79, 135, 255, 0.12), transparent 70%);
	}
	.eyebrow {
		font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.14em;
		color: var(--text-muted); margin-bottom: 16px; display: inline-flex; align-items: center; gap: 8px;
	}
	.live-dot { width: 9px; height: 9px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; display: inline-block; }
	@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
	h1 { font-size: 3rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; margin-bottom: 16px; }
	h1 span { background: linear-gradient(135deg, var(--accent), var(--green)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
	.sub { color: var(--text-muted); font-size: 1.1rem; max-width: 640px; margin: 0 auto 32px; line-height: 1.7; }
	.sub strong { color: var(--text); }

	.hero-stats { display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 14px; max-width: 900px; margin: 0 auto; }
	.stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; text-align: left; }
	.stat .k { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 6px; }
	.stat .v { display: block; font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
	.stat .n { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; }
	.stat.total .v { font-size: 2.6rem; }
	.stat.flow .v { color: var(--accent); }
	.stat.public .v { color: var(--green); }

	.bar { height: 12px; border-radius: 8px; overflow: hidden; display: flex; background: var(--bg-card); border: 1px solid var(--border); max-width: 900px; margin: 18px auto 8px; }
	.bar i { display: block; height: 100%; }
	.bar .f { background: var(--accent); }
	.bar .p { background: var(--green); }
	.bar-note { color: var(--text-muted); font-size: 0.82rem; max-width: 900px; margin: 0 auto; }

	.ledger-method { border-top: 1px solid var(--border); }
	.ledger-method h2 { text-align: center; font-size: 1.6rem; margin-bottom: 28px; }
	.method-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; max-width: 900px; margin: 0 auto; }
	.m-card { background: var(--bg-card); border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: var(--radius); padding: 20px; }
	.m-card.flow { border-left-color: var(--accent); }
	.m-card.public { border-left-color: var(--green); }
	.m-card.context { border-left-color: var(--text-muted); }
	.m-card h3 { font-size: 1rem; margin-bottom: 8px; }
	.m-card p { color: var(--text-muted); font-size: 0.9rem; line-height: 1.6; }
	.proof { max-width: 900px; margin: 22px auto 0; text-align: center; color: var(--text-muted); font-size: 0.9rem; background: var(--bg-card); border: 1px dashed var(--border); border-radius: var(--radius); padding: 14px 20px; }

	.ledger-list { border-top: 1px solid var(--border); }
	.controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
	input, select {
		background: var(--bg-card); border: 1px solid var(--border); color: var(--text);
		padding: 10px 13px; border-radius: 9px; font-size: 0.9rem;
	}
	input { flex: 1; min-width: 220px; }
	select { cursor: pointer; }
	.count { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 16px; }

	.cards { display: flex; flex-direction: column; gap: 12px; }
	.inc { background: var(--bg-card); border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: var(--radius); padding: 20px 22px; }
	.inc.has-money { border-left-color: var(--accent); }
	.inc-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
	.inc h3 { font-size: 1.05rem; font-weight: 600; line-height: 1.4; }
	.amt { white-space: nowrap; font-weight: 700; font-variant-numeric: tabular-nums; display: flex; gap: 10px; }
	.amt .f { color: var(--accent); }
	.amt .p { color: var(--green); }
	.meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0; font-size: 0.8rem; color: var(--text-muted); }
	.tag { background: rgba(161,161,170,0.1); border: 1px solid var(--border); padding: 2px 9px; border-radius: 20px; }
	.tag.unv { color: var(--red); border-color: rgba(239,68,68,0.3); }
	.est { color: var(--red); font-size: 0.8rem; }
	.sum { color: var(--text); opacity: 0.9; font-size: 0.93rem; line-height: 1.65; margin: 8px 0; }
	.basis { font-size: 0.82rem; color: var(--text-muted); border-left: 2px solid var(--border); padding: 4px 0 4px 12px; margin: 8px 0; font-style: italic; }
	.cites { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
	.cite { font-size: 0.78rem; background: var(--bg-hover); border: 1px solid var(--border); padding: 3px 10px; border-radius: 7px; color: var(--text-muted); text-decoration: none; }
	.cite:hover { color: var(--text); border-color: var(--text-muted); }
	.cite.t0 { border-color: rgba(34,197,94,0.4); color: var(--green); }
	.empty { text-align: center; color: var(--text-muted); padding: 48px 0; }

	@media (max-width: 760px) {
		.hero-stats { grid-template-columns: 1fr; }
		.stat.total .v { font-size: 2rem; }
		h1 { font-size: 2.2rem; }
		.inc-head { flex-direction: column; }
		.amt { white-space: normal; }
	}
</style>
