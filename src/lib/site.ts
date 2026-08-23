// Build-mode switches for the two places this site is deployed.
//
// LAN is the DEFAULT, deliberately: an unadorned `bun run build` — which is what
// the Jenkins job runs — must produce exactly what it always did. Its Gate stage
// fails the build if "github.com" appears anywhere in dist/ and requires the
// canonical to be the LAN host, so anything public-only has to be opt-in rather
// than opt-out. Set PUBLIC_SITE=1 to build the public variant.
//
// Read through process.env as well as import.meta.env: every consumer here runs
// at build time (static output), and only import.meta.env is inlined by Vite —
// a var set purely in the shell reaches us via process.env.
function envVar(name: string): string | undefined {
	const fromVite = (import.meta.env as Record<string, unknown>)[name];
	if (typeof fromVite === 'string') return fromVite;
	return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

export const isPublic = envVar('PUBLIC_SITE') === '1';

/**
 * Astro's configured base ("/" when unset). It is NOT guaranteed to end with a
 * slash — with `base: '/crust-website'` it has none — so always normalise
 * before joining rather than concatenating straight onto it.
 */
export const base: string = import.meta.env.BASE_URL ?? '/';

/**
 * Make a root-relative internal link base-aware.
 *
 * A GitHub Pages project site is served from a subpath, and Astro does NOT
 * rewrite hrefs in markup — it only makes `base` available. So a literal
 * href="/docs/" silently 404s under a base, and nothing at build time catches
 * it. Route every internal link through here instead.
 *
 * Anything not starting with a single "/" (external URLs, "//cdn…", "#anchor",
 * relative paths) is returned untouched.
 */
export function href(path: string): string {
	if (!path.startsWith('/') || path.startsWith('//')) return path;
	const prefix = base.replace(/\/+$/, '');
	if (!prefix) return path;
	// Idempotent: the MDX rehype pass also prefixes links, so a value that has
	// already been based must not be based twice.
	if (path === prefix || path.startsWith(`${prefix}/`)) return path;
	return `${prefix}${path}`;
}

/**
 * Strip the base off a pathname so it can be compared against literal route
 * prefixes. `Astro.url.pathname` INCLUDES the base, so nav active-state checks
 * like `pathname.startsWith('/docs')` stop matching under a subpath deploy.
 */
export function routePath(pathname: string): string {
	const prefix = base.replace(/\/+$/, '');
	if (prefix && pathname.startsWith(prefix)) {
		return pathname.slice(prefix.length) || '/';
	}
	return pathname;
}

/**
 * The install command shown on the site. The LAN one-liner resolves crust
 * through apps.in.drlario.org/index.tsv; the public one reads the installer
 * straight out of the repo. Both verify the published sha256 before installing,
 * and neither needs a clone or Bun on the target machine.
 */
export const INSTALL_COMMAND = isPublic
	? 'curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash'
	: 'curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- crust';

/** Public-mode only — a LAN build must not emit this (see the Gate note above). */
export const REPO_URL = 'https://github.com/lariocpt/crust';
