# crust-website

The documentation site for [crust](https://github.com/lariocpt/crust) — the
whole test stack baked into one binary: spec-driven mocks, generated fixtures,
load gates, and log tooling, with zero dependencies.

Astro 6 + MDX, static output, built with Bun.

```bash
bun install
bun run dev      # http://localhost:4321
bun run build    # -> dist/
bun run preview
```

## Two build modes

One codebase, two deployment targets. The mode is chosen entirely by build-time
environment variables, so flipping between them is a config change, never a code
change.

| | LAN (default) | Public |
|---|---|---|
| Canonical host | `https://crust.in.drlario.org` | whatever `SITE_URL` says |
| Install command shown | LAN artifact plane | `curl … githubusercontent … \| bash` |
| Repo link in header | hidden | shown |
| `PUBLIC_SITE` | unset | `1` |

```bash
# LAN build — what Jenkins runs, and the default for a bare `bun run build`
bun run build

# Public build (e.g. GitHub Pages under a subpath)
PUBLIC_SITE=1 SITE_URL=https://lariocpt.github.io/crust-website BASE_PATH=/crust-website bun run build
```

`BASE_PATH` exists because a GitHub Pages *project* site is served from a
subpath. Internal links go through `src/lib/site.ts` so they pick it up; use
`href(...)` there rather than hardcoding a root-relative path.

## Examples are checked, not trusted

Every `bash`/`crust` code block on this site is run through `crust --check`,
which parses a line without executing it. The site cannot import crust's lexer
(separate repo), so the real binary is the bridge:

```bash
bun scripts/lint-examples.mjs /path/to/crust
```

Jenkins runs this as its `Grammar` stage against the binary it already mounts.
The linter fails if it finds *zero* examples, on the theory that a broken
extractor should not look like clean docs.

MIT © 2026 Lario Borges
