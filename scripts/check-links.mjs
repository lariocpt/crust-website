#!/usr/bin/env node
/**
 * Fail on any internal link in the built site that points at a page the build
 * did not produce, or at an anchor that page does not carry.
 *
 * WHY. `astro build` reports complete success no matter what an `href` says: a
 * route that 404s is not a build error, it is a live site with a broken
 * button. The case that motivated this file: while syncing the agent-skills
 * page to the nine skills the binary registers, the new table linked five
 * routes that were never built (the four skills with no page, plus
 * `/docs/builtins/`). `bun run build` passed, and nothing else in the repo
 * would have noticed — the grammar gate checks code blocks, on `main` only.
 *
 * It runs on the BUILD OUTPUT, not the source, so it checks what users receive:
 * Astro's own route handling is already resolved, and prose in a frontmatter
 * `description` is not mistaken for a link.
 *
 * ANCHORS. A fragment that names no heading is invisible to the route check —
 * the page resolves, so the link is "fine" — and it is easy to write by
 * accident, because the slug is not always the heading text. A heading that
 * opens with inline code keeps that code's own punctuation, so
 * `## `--check`: the linter, and its edges` emits
 * `id="--check-the-linter-and-its-edges"`, leading dashes and all, while the
 * table cell pointing at it read `#check-the-linter-and-its-edges`. That link
 * merged green through the PR checks and only crust's own `verify-web-links`
 * — which runs *after* the Pages deploy — saw it, so the red landed on `main`.
 *
 * Only `id=` counts as a target: the build emits heading ids and nothing else
 * (no legacy `<a name=>` survives in `dist/`), and widening it to `name=`
 * would let `<meta name=…>` answer any fragment that shares a meta's name.
 * A fragment on a non-HTML target (a sitemap, a binary) is skipped — there is
 * no anchor list there to read — and the route check still runs on it.
 *
 * BASE PATH. A public build (`BASE_PATH=/crust-website`) emits every internal
 * href under that prefix while the files still sit at the root of `dist/`, so a
 * naive check reports every link on the site as dead — which is exactly the
 * noise that gets a check turned off. `BASE_PATH` is honoured when set;
 * otherwise the prefix is inferred, and only when every internal href shares
 * one first segment that does NOT exist in `dist`. Anything looser falls back
 * to no base, so a genuine typo stays visible instead of being explained away.
 *
 * External URLs (http(s)://, mailto:, tel:) are skipped on purpose: they are
 * checked for liveness elsewhere, where a 403 from a bot-protected host can be
 * told apart from a page we never built.
 *
 * Run after `bun run build` (plain `node` works too):
 *   bun scripts/check-links.mjs             # checks ./dist
 *   bun scripts/check-links.mjs some/dist   # or a given build directory
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist");

/** Targets a browser resolves against the same origin. */
const INTERNAL = /^(?!https?:|mailto:|tel:|data:|#|javascript:)/i;
const HREF = /(?:href|src)="([^"]+)"/gi;
const HEADING_ID = /\bid="([^"]+)"/g;

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_astro" || entry.name.startsWith(".")) continue;
      out.push(...(await htmlFiles(p)));
    } else if (entry.name.endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

/** Strips a fragment/query, percent-decodes, and removes a leading `/` or `./`. */
function cleanTarget(raw) {
  return decodeURIComponent(raw.split("#")[0].split("?")[0]).replace(/^\.?\/+/, "");
}

/** The fragment of an href, or null for none and for a bare `#`. */
function fragmentOf(raw) {
  const at = raw.indexOf("#");
  if (at === -1) return null;
  const frag = raw.slice(at + 1).split("?")[0];
  return frag === "" ? null : decodeURIComponent(frag);
}

/** Astro emits a route as `route/index.html` or `route.html`; either counts. */
function serveCandidates(rel) {
  return rel === "" ? ["index.html"] : [`${rel}/index.html`, `${rel}.html`, rel];
}

async function isServed(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const files = await htmlFiles(DIST);
if (files.length === 0) {
  console.error(`check-links: no .html under ${DIST} — run \`bun run build\` first`);
  process.exit(1);
}

// ---- collect every internal link, per page, plus the anchors each page has ----
const pages = [];
const anchorsByFile = new Map();
for (const file of files) {
  const html = await readFile(file, "utf8");
  const anchors = new Set([...html.matchAll(HEADING_ID)].map((m) => m[1]));
  anchorsByFile.set(file, anchors);
  const pageDir = file.slice(0, -"index.html".length);
  const links = [];
  for (const match of html.matchAll(HREF)) {
    const raw = match[1];
    if (raw.startsWith("#")) {
      // Same-page link: no route to resolve, but the anchor is still a promise.
      if (fragmentOf(raw)) links.push({ raw, samePage: true });
      continue;
    }
    if (!INTERNAL.test(raw) || cleanTarget(raw) === "") continue;
    links.push({ raw, samePage: false });
  }
  pages.push({ file, pageDir, links });
}

// ---- base path: env first, then a strict inference, then none ----
const allLinks = pages.flatMap((p) => p.links.map((l) => l.raw));
async function detectBase() {
  const fromEnv = (process.env.BASE_PATH ?? "").replace(/\/+$/, "");
  if (fromEnv) return { base: fromEnv, why: "BASE_PATH" };
  const roots = new Set(allLinks.filter((l) => l.startsWith("/")).map((l) => cleanTarget(l).split("/")[0]));
  if (roots.size !== 1) return { base: "", why: "no shared prefix" };
  const [root] = [...roots];
  if (await isServed(join(DIST, root))) return { base: "", why: "prefix is a real route" };
  return { base: `/${root}`, why: "inferred" };
}
const { base, why: baseWhy } = await detectBase();

const baseRel = base.replace(/^\/+/, "");
/** Where a root-absolute or page-relative href lands in `dist`, or null if nowhere. */
async function servedAs(pageDir, raw) {
  const target = cleanTarget(raw);
  // A root-absolute href may carry the base prefix; a relative one resolves
  // against the page's own directory instead.
  const underBase = baseRel && (target === baseRel || target.startsWith(`${baseRel}/`));
  const rel = normalize(join(pageDir, target));
  const paths = raw.startsWith("/")
    ? serveCandidates(underBase ? target.slice(baseRel.length + 1) : target)
    : [rel, ...serveCandidates(rel)];
  for (const p of paths) {
    const abs = resolve(DIST, p);
    if (await isServed(abs)) return abs;
  }
  return null;
}

const dead = [];
const badAnchors = [];
let checked = 0;
let anchorsChecked = 0;
for (const { file, pageDir, links } of pages) {
  for (const { raw, samePage } of links) {
    checked++;
    const fragment = fragmentOf(raw);
    if (samePage) {
      anchorsChecked++;
      if (!anchorsByFile.get(file).has(fragment)) {
        badAnchors.push(`${file.replace(`${DIST}/`, "")} -> ${raw}`);
      }
      continue;
    }
    const served = await servedAs(pageDir, raw);
    if (!served) {
      dead.push(`${file.replace(`${DIST}/`, "")} -> ${raw}`);
      continue;
    }
    if (!fragment || !served.endsWith(".html")) continue;
    anchorsChecked++;
    if (!anchorsByFile.get(served)?.has(fragment)) {
      badAnchors.push(`${file.replace(`${DIST}/`, "")} -> ${raw}`);
    }
  }
}

const baseNote = base ? ` (base ${base}, ${baseWhy})` : "";
const summary = `${checked} internal link(s) (${anchorsChecked} with an anchor) across ${files.length} page(s)`;
if (dead.length > 0 || badAnchors.length > 0) {
  const parts = [];
  if (dead.length > 0) parts.push(`${dead.length} dead`);
  if (badAnchors.length > 0) parts.push(`${badAnchors.length} anchorless`);
  console.error(`check-links: ${parts.join(", ")} internal link(s) in ${summary}${baseNote}\n`);
  for (const d of [...new Set(dead)]) console.error(`  no page   ${d}`);
  for (const a of [...new Set(badAnchors)]) console.error(`  no anchor ${a}`);
  process.exit(1);
}
console.log(`check-links: ${summary}, 0 dead${baseNote}`);
