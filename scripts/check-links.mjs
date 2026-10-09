#!/usr/bin/env node
/**
 * Fail on any internal link in the built site that points at a page the build
 * did not produce.
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

// ---- collect every internal link, per page, with relative ones resolved ----
const pages = [];
for (const file of files) {
  const html = await readFile(file, "utf8");
  const pageDir = file.slice(0, -"index.html".length);
  const links = [];
  for (const match of html.matchAll(HREF)) {
    const raw = match[1];
    if (!INTERNAL.test(raw) || cleanTarget(raw) === "") continue;
    links.push(raw.startsWith("#") ? null : raw);
  }
  pages.push({ file, pageDir, links: links.filter(Boolean) });
}
const allLinks = pages.flatMap((p) => p.links);

// ---- base path: env first, then a strict inference, then none ----
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

const dead = [];
let checked = 0;
const baseRel = base.replace(/^\/+/, "");
for (const { file, pageDir, links } of pages) {
  for (const raw of links) {
    checked++;
    const target = cleanTarget(raw);
    // A root-absolute href may carry the base prefix; a relative one resolves
    // against the page's own directory instead.
    const underBase = baseRel && (target === baseRel || target.startsWith(`${baseRel}/`));
    const paths = raw.startsWith("/")
      ? serveCandidates(underBase ? target.slice(baseRel.length + 1) : target)
      : [normalize(join(pageDir, target)), ...serveCandidates(normalize(join(pageDir, target)))];
    const served = (await Promise.all(paths.map((p) => isServed(resolve(DIST, p))))).some(Boolean);
    if (!served) dead.push(`${file.replace(`${DIST}/`, "")} -> ${raw}`);
  }
}

const baseNote = base ? ` (base ${base}, ${baseWhy})` : "";
if (dead.length > 0) {
  console.error(`check-links: ${dead.length} dead internal link(s) in ${checked} checked${baseNote}\n`);
  for (const d of [...new Set(dead)]) console.error(`  ${d}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal link(s) across ${files.length} page(s), 0 dead${baseNote}`);
