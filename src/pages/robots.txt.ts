import type { APIRoute } from 'astro';

// A route, not public/robots.txt, because a static file cannot follow the
// configured site. The old one hardcoded the LAN sitemap URL, so any build
// pointed elsewhere advertised a sitemap on a host it was not served from —
// while dist/sitemap-index.xml, which IS generated from `site`, disagreed with
// it. NOTE: public/ is copied over the build output, so the static copy must
// stay deleted or it silently wins over this route.
export const GET: APIRoute = ({ site }) => {
	// astro.config.mjs guarantees `site` is set; the type is still URL | undefined.
	if (!site) throw new Error('robots.txt: astro.config `site` is unset');

	// BASE_URL is not guaranteed to carry a trailing slash (it does not when
	// `base` is configured without one), so join explicitly rather than by
	// concatenation — that produced ".../crust-websitesitemap-index.xml".
	const basePath = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
	const sitemap = new URL(`${basePath}/sitemap-index.xml`, site);

	return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
};
