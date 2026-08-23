// @ts-check
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// Astro does not rewrite hrefs written in markup — configuring `base` only
// changes where pages are EMITTED and what `Astro.url.pathname` reports. So a
// literal `[Quickstart](/docs/quickstart/)` in an .mdx file keeps pointing at
// the domain root and silently 404s under a subpath deploy, with nothing at
// build time to catch it.
//
// .astro components route their links through href() in src/lib/site.ts. MDX
// prose is the long tail — 65 links across the docs — so rather than rewrite
// (and keep rewriting) every one by hand, prefix them here, after markdown has
// been turned into HTML. No-op when no base is configured.
function rehypeBasePath() {
	const prefix = (process.env.BASE_PATH ?? '/').replace(/\/+$/, '');
	// Single leading slash only: "//cdn.example.com" is protocol-relative, i.e.
	// absolute, not an internal path.
	const internal = (v) => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//');
	const ATTRS = ['href', 'src'];

	return () => (tree) => {
		if (!prefix) return;
		const walk = (node) => {
			// Plain markdown links and raw HTML -> hast `element` with `properties`.
			if (node.type === 'element' && node.properties) {
				for (const attr of ATTRS) {
					if (internal(node.properties[attr])) {
						node.properties[attr] = `${prefix}${node.properties[attr]}`;
					}
				}
			}
			// A JSX component in MDX (<RecipeCard href="/docs/…" />) is NOT an
			// `element` — it is an mdxJsx*Element carrying an `attributes` ARRAY.
			// Missing this is why the recipes index kept emitting unbased links
			// while every markdown link on the same page was rewritten correctly.
			if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
				for (const attr of node.attributes ?? []) {
					if (attr.type === 'mdxJsxAttribute' && ATTRS.includes(attr.name) && internal(attr.value)) {
						attr.value = `${prefix}${attr.value}`;
					}
				}
			}
			for (const child of node.children ?? []) walk(child);
		};
		walk(tree);
	};
}

// https://astro.build/config
export default defineConfig({
	// The canonical host. SITE_URL overrides it, which is how a public build
	// points somewhere else without editing this file.
	//
	// This must never resolve to undefined: src/layouts/Layout.astro does
	// `new URL(Astro.url.pathname, Astro.site)` and that throws on an undefined
	// base, so the whole build fails rather than merely emitting a wrong
	// canonical tag.
	site: process.env.SITE_URL ?? 'https://crust.in.drlario.org',
	// A GitHub Pages *project* site lives under /<repo>. Unset everywhere else,
	// including the LAN vhost, which serves from the domain root.
	base: process.env.BASE_PATH ?? '/',
	integrations: [mdx(), sitemap()],
	markdown: {
		rehypePlugins: [rehypeBasePath()],
		shikiConfig: {
			theme: 'github-dark',
			langs: ['bash', 'sh', 'shell', 'typescript', 'ts', 'json', 'yaml'],
			wrap: true,
		},
	},
});
