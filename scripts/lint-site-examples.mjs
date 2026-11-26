#!/usr/bin/env node
/**
 * The @crust/site docs gate for THIS site — the TypeScript analogue of
 * lint-examples.mjs.
 *
 * lint-examples.mjs validates the site's crust lines by RUNNING the crust
 * binary (`crust --check`). That bridge cannot help with the @crust/site
 * pages: their examples are TypeScript, not crust lines. The bridge here is
 * the compiler: every ```ts fence under src/pages/docs/site/ is extracted,
 * wrapped with a standard prelude (the package's public surface), and
 * TYPE-CHECKED with tsc --noEmit against the real package's public types —
 * the same approach packages/site/scripts/lint-docs.mjs uses for the
 * package's own README/USAGE, pointed at this repo's pages instead.
 * An example that does not compile is a broken example, exactly like a crust
 * line that does not parse.
 *
 * THE PACKAGE PATH is argv[2], defaulting to ../crust/packages/site (the
 * sibling checkout). If it does not exist the script prints a LOUD
 *   SKIPPED (site package not found at <path>)
 * and exits 0. That is deliberate: the Jenkins Grammar stage runs this
 * before ops has provisioned the package mount, and a hard fail would break
 * CI for every crust PR until the mount landed — while a SILENT skip would
 * be the exact rot this repo already fought (the site drifted from crust for
 * weeks because nothing here could fail for it). A visible skip keeps the
 * pressure without holding the pipeline hostage. The same loud-skip rule
 * applies when bun-types or tsc cannot be resolved from the package: the
 * gate cannot run, says so loudly, and stays green.
 *
 * Fence contract (mirrors lint-docs.mjs): a fence either manages its own
 * imports (any `import` statement) or gets the prelude; `"@crust/site"`
 * resolves through the generated tsconfig's paths map to <pkg>/src/index.ts,
 * so fences read exactly as a user's files do. A per-file fence-count canary
 * (docs-lint.test.ts's minLines pattern) makes a scanner that silently stops
 * finding examples fail, not pass by checking nothing.
 *
 * Run (from this repo's root; plain `node` or `bun` both work):
 *   bun scripts/lint-site-examples.mjs                       # default path
 *   bun scripts/lint-site-examples.mjs ../crust/packages/site
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCS_ROOT = join(REPO, "src/pages/docs/site");

/**
 * Per-file fence canaries — slightly below the real counts, so deleting an
 * example is fine but a scanner finding (almost) nothing is not. A file with
 * no ts fences by design (intro) is absent and contributes nothing.
 */
const CANARIES = {
  "quickstart.mdx": 3,
  "config.mdx": 5,
  "templates.mdx": 5,
  "content.mdx": 1,
  "diagnostics.mdx": 2,
};

/** The standard prelude — the package's public surface (mirrors lint-docs.mjs). */
const PRELUDE = [
  "import {",
  "  build,",
  "  canonicalUrl,",
  "  checkOutputOverlap,",
  "  defineSite,",
  "  findRouteCollisions,",
  "  finalizeDocument,",
  "  html,",
  "  isNormalizedRoute,",
  "  normalizeRoute,",
  "  parseFrontmatter,",
  "  resolveConfigPaths,",
  "  routeToFile,",
  "  url,",
  "  validateUrl,",
  "  BuildError,",
  "  DiagnosticCodes,",
  "  sortDiagnostics,",
  '} from "@crust/site";',
  "import type {",
  "  BuildOptions,",
  "  BuildPage,",
  "  BuildResult,",
  "  Diagnostic,",
  "  DiagnosticCode,",
  "  FrontmatterResult,",
  "  Html,",
  "  HtmlValue,",
  "  Layout,",
  "  LayoutContext,",
  "  Page,",
  "  PageFrontmatter,",
  "  ResolvedSite,",
  "  RouteEntry,",
  "  Severity,",
  "  Site,",
  "  SiteConfig,",
  '} from "@crust/site";',
];

function skip(reason) {
  console.error(`\n*** SKIPPED — ${reason}`);
  console.error("*** This is a visible skip, not a pass: the @crust/site pages were NOT type-checked.\n");
  process.exit(0);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".mdx")) out.push(p);
  }
  return out;
}

/**
 * Extract every ```ts fence from a markdown file. Fence tracking toggles on
 * ANY line-initial run of >= 3 backticks (so a nested ```sh or ```bash block
 * is skipped whole, never half-read); only the `ts` info string is collected.
 * Returns 1-based open-line numbers and the content lines. (Byte-for-byte the
 * extractor from packages/site/scripts/lint-docs.mjs — the two gates must
 * accept and reject the same fences.)
 */
function extractTsFences(text) {
  const lines = text.split("\n");
  const fences = [];
  let open = null; // { n, info, startLine, content: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(`{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m) open = { n: m[1].length, info: m[2].trim(), startLine: i + 1, content: [] };
      continue;
    }
    const close = new RegExp(`^\`{${open.n},}\\s*$`);
    if (close.test(line)) {
      if (open.info === "ts") fences.push({ startLine: open.startLine, content: open.content });
      open = null;
      continue;
    }
    open.content.push(line);
  }
  if (open !== null) throw new Error(`unclosed \`\`\`${open.info} fence at line ${open.startLine}`);
  return fences;
}

/** First existing of the candidate paths, or null. */
function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) ?? null;
}

function main() {
  const pkg = resolve(process.argv[2] ?? join(REPO, "../crust/packages/site"));
  if (!existsSync(join(pkg, "src/index.ts"))) {
    skip(`site package not found at ${pkg} — pass the path to a @crust/site checkout as argv`);
  }

  // 1. Extract fences, enforce the canaries.
  const failures = [];
  const fences = [];
  const files = walk(DOCS_ROOT).sort();
  if (files.length === 0) {
    console.error("lint-site-examples: no .mdx under src/pages/docs/site — the scanner is broken");
    process.exit(1);
  }
  for (const file of files) {
    const label = relative(REPO, file);
    const found = extractTsFences(readFileSync(file, "utf8"));
    const min = CANARIES[basename(file)] ?? 0;
    if (found.length < min) {
      failures.push(
        `${label}: only ${found.length} \`\`\`ts fences found (canary: >= ${min}) — ` +
          "a scanner that finds no examples must fail, never pass by checking nothing",
      );
    }
    for (const f of found) fences.push({ ...f, label });
  }
  if (fences.length === 0) {
    failures.push("no ```ts fences found anywhere under src/pages/docs/site — the extractor is broken");
  }
  if (failures.length > 0) {
    console.error(`lint-site-examples: FAILED\n\n${failures.join("\n\n")}\n`);
    process.exit(1);
  }

  // 2. Resolve the toolchain from the package's own tree (the crust repo
  //    checkout carries typescript and bun-types at its root; a provisioned
  //    mount must make both reachable, or the gate loudly cannot run).
  const bunTypes = firstExisting([
    join(pkg, "node_modules/bun-types"),
    join(pkg, "../../node_modules/bun-types"),
    join(pkg, "node_modules/@types/bun"),
    join(pkg, "../../node_modules/@types/bun"),
  ]);
  if (bunTypes === null) {
    skip(`bun-types not resolvable from ${pkg} — the package's own types need Bun globals to compile`);
  }
  const tsc = firstExisting([
    join(pkg, "../../node_modules/typescript/bin/tsc"),
    join(pkg, "node_modules/typescript/bin/tsc"),
    join(REPO, "node_modules/typescript/bin/tsc"),
  ]);

  // 3. Type-check every fence in a temp dir (never inside either repo). The
  //    tsconfig's paths map sends "@crust/site" to the package's entry, so
  //    fences import exactly what a user's files do.
  const staging = mkdtempSync(join(tmpdir(), "crust-site-docs-"));
  let report = null; // the verdict, applied only AFTER the finally cleanup
  try {
    const fenceByFile = new Map();
    let index = 0;
    for (const fence of fences) {
      const body = fence.content.join("\n");
      const ownImports = /^\s*import\s/m.test(body);
      const source = ownImports ? body : `${PRELUDE.join("\n")}\n${body}`;
      const name = `${basename(fence.label, ".mdx")}-${index++}.ts`;
      fence.name = name;
      fence.offset = ownImports ? 0 : PRELUDE.length;
      fenceByFile.set(name, fence);
      writeFileSync(join(staging, name), `${source}\n`);
    }
    writeFileSync(
      join(staging, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            lib: ["ESNext"],
            target: "ESNext",
            module: "ESNext",
            moduleDetection: "force",
            allowJs: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            noFallthroughCasesInSwitch: true,
            // bun-types is pulled in explicitly via `files` (below) rather
            // than `types`, because the staging dir sits outside the
            // package's node_modules walk-up and `types` would not find it.
            types: [],
            baseUrl: pkg,
            paths: { "@crust/site": ["src/index.ts"] },
          },
          files: [join(bunTypes, "index.d.ts")],
          include: ["*.ts"],
        },
        null,
        2,
      ),
    );

    const run =
      tsc !== null
        ? spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(staging, "tsconfig.json")], {
            encoding: "utf8",
            cwd: pkg,
          })
        : spawnSync("bun", ["x", "tsc", "--noEmit", "-p", join(staging, "tsconfig.json")], {
            encoding: "utf8",
            cwd: pkg,
          });
    // No process.exit() inside the try: Node/Bun terminate immediately on
    // process.exit and never run the finally below, which would leak the
    // staging dir into /tmp on every failing run (measured: the exit-1 path
    // left its mkdtemp dir behind). The verdict is recorded and applied
    // AFTER the cleanup.
    if (run.error) {
      // No local tsc and no bun to fetch one: the gate cannot run. Loud skip,
      // same philosophy as the missing package path.
      report = {
        kind: "skip",
        text: `no tsc available (looked for ${join(pkg, "../../node_modules/typescript")} and \`bun x tsc\`): ${run.error.message}`,
      };
    } else if (run.status !== 0) {
      const mapped = `${run.stdout ?? ""}${run.stderr ?? ""}`
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => mapTscLine(l, fenceByFile))
        .join("\n");
      report = { kind: "fail", text: `tsc --noEmit failed for the documented examples:\n${mapped}` };
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // Apply the verdict only after the staging dir is gone: process.exit()
  // terminates the process immediately and never runs a finally, so an
  // exit INSIDE the try would leak the mkdtemp dir into /tmp on every red
  // run (measured — the old exit-1/exit-0 paths left their dirs behind).
  if (report !== null) {
    if (report.kind === "skip") {
      skip(report.text);
    } else {
      console.error(`lint-site-examples: FAILED\n\n${report.text}\n`);
      process.exit(1);
    }
  }

  const counts = files
    .map((f) => {
      const label = relative(REPO, f);
      return `${label}: ${fences.filter((x) => x.label === label).length}`;
    })
    .join(", ");
  console.log(`lint-site-examples: OK — ${fences.length} ts fence(s) type-checked (${counts}).`);
}

/** Map a tsc line back to `page.mdx:line`, or pass other paths through. */
function mapTscLine(rawLine, fenceByFile) {
  const m = /^(.+?)\((\d+),(\d+)\): (error \S+): (.*)$/.exec(rawLine.trim());
  if (m === null) return `  ${rawLine.trim()}`;
  const [, file, lineStr, col, err, message] = m;
  const line = Number(lineStr);
  const base = basename(file);
  const fence = fenceByFile.get(base);
  if (fence === undefined) return `  ${file}:${line}:${col}: ${err}: ${message}`;
  const docLine = fence.startLine + (line - fence.offset);
  const where =
    line <= fence.offset
      ? `${fence.label}:${fence.startLine} (generated prelude)`
      : `${fence.label}:${docLine}`;
  return `  ${where}: ${err}: ${message}`;
}

main();
