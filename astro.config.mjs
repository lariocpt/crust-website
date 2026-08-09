// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// https://astro.build/config
export default defineConfig({
	// crust is not public yet, so the canonical host is the LAN vhost Caddy already serves
	// at /srv/sites/crust-website/current. SITE_URL overrides it, which is how a future
	// public build would point somewhere else without editing this file.
	//
	// This must never resolve to undefined: src/layouts/Layout.astro does
	// `new URL(Astro.url.pathname, Astro.site)` and that throws on an undefined base, so the
	// whole build fails rather than merely emitting a wrong canonical tag.
	site: process.env.SITE_URL ?? 'https://crust.in.drlario.org',
	integrations: [mdx()],
	markdown: {
		shikiConfig: {
			theme: 'github-dark',
			langs: ['bash', 'sh', 'shell', 'typescript', 'ts', 'json', 'yaml'],
			wrap: true,
		},
	},
});
