<script lang="ts">
	import '../app.css';

	let { children } = $props();

	let scrolled = $state(false);

	$effect(() => {
		const onScroll = () => {
			scrolled = window.scrollY > 60;
		};
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	});
</script>

<svelte:head>
	<link rel="icon" href="/ldk-logo.png" />
	<title>LeftyDevKit — Building tech for a better world</title>
	<meta name="description" content="Open-source progressive civic-tech tools. Free for candidates and organizers who align with our values." />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta property="og:image" content="/ldk-logo.png" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<nav class:scrolled>
	<div class="container">
		<a href="/" class="logo">
			<img src="/ldk-logo.png" alt="LeftyDevKit" class="logo-img" />
			<span class="logo-text">Lefty<span>DevKit</span></span>
		</a>
		<div class="nav-links">
			<a href="/">Home</a>
			<a href="/ledger">Corruption Ledger</a>
			<a href="/gep">God's Eye</a>
			<a href="https://github.com/leftydevkit/leftydevkit" target="_blank">GitHub</a>
		</div>
	</div>
</nav>

<div class="hero-bg"></div>

{@render children()}

<footer>
	<div class="container">
		    <p>LeftyDevKit — <a href="https://github.com/leftydevkit/leftydevkit">open source</a> &bull; MIT license &bull; Free for progressive candidates and organizers</p>
		    <p style="margin-top: 8px; font-size: 0.8rem;">Built in public on stream. Every line of code, every shitpost, every build failure — <a href="https://github.com/leftydevkit/leftydevkit">watch it happen</a>.</p>
	</div>
</footer>
