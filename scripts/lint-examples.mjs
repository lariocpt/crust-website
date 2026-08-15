#!/usr/bin/env node
// Parse every crust example on this site against the real crust grammar.
//
// The site's code blocks are hand-maintained copies of the docs, with no
// generation step — exactly the thing that rots. crust's own repo lints its
// docs by importing the lexer, but this is a SEPARATE repo and cannot. What it
// can do is run the binary: `crust --check '<lines>'` parses without executing
// (no file is opened, nothing is spawned), so an example referencing
// fixtures/*.json or :3000 checks clean on a machine that has neither.
//
// Usage: node scripts/lint-examples.mjs [path-to-crust]
// Exits 1 with the offending line if anything fails to parse.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const CRUST = process.argv[2] ?? process.env.CRUST_BIN ?? "crust";
const ROOTS = ["src/pages", "src/components"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".mdx") || p.endsWith(".astro")) out.push(p);
  }
  return out;
}

// Strip an UNQUOTED top-level `#` comment (crust has no inline-comment syntax,
// so trailing `#` text in a doc block is prose) and track whether the line
// leaves quotes or brackets open, so `procs({` and multi-line `crust -c '…'`
// are joined with their continuation instead of parsed as fragments.
function scanLine(line, open) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (open.q) {
      out += c;
      if (open.q === '"' && c === "\\" && i + 1 < line.length) out += line[++i];
      else if (c === open.q) open.q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      open.q = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") open.depth++;
    if (c === ")" || c === "}" || c === "]") open.depth--;
    if (c === "#" && open.depth === 0) break;
    out += c;
  }
  return out;
}

const examples = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/```(?:bash|crust)\n([\s\S]*?)```/g)) {
      const body = m[1];
      if (body.includes("<<")) continue; // heredoc payload, not a crust line
      const open = { q: null, depth: 0 };
      let buf = "";
      for (const raw of body.replace(/\\\n\s*/g, " ").split("\n")) {
        const trimmed = raw.trim();
        if (!buf && (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("$"))) continue;
        buf += (buf ? " " : "") + scanLine(raw, open).trim();
        if (open.q || open.depth > 0) continue;
        const line = buf.trim();
        buf = "";
        if (line) examples.push({ file, line });
      }
    }
  }
}

if (examples.length === 0) {
  console.error("lint-examples: found no code blocks — the extractor is broken, not the docs");
  process.exit(1);
}

// Examples reference environment variables that only exist at run time
// ($TOKEN, $BASE, $GEN_AUTH_HEADER…). crust expands them at parse time, so an
// unset one turns `-H "$AUTH"` into `-H ""` and trips the "Key: value" check —
// a fact about this shell, not about the example. Give every referenced name a
// value that satisfies the shapes crust validates.
const PLACEHOLDER = "x-crust-lint: placeholder";
function envFor(line) {
  const env = { ...process.env };
  for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    if (env[m[1]] === undefined) env[m[1]] = PLACEHOLDER;
  }
  return env;
}

let failed = 0;
for (const { file, line } of examples) {
  const r = spawnSync(CRUST, ["--check", line], { encoding: "utf8", env: envFor(line) });
  if (r.error) {
    console.error(`lint-examples: cannot run ${CRUST}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${relative(process.cwd(), file)}`);
    console.error(`     ${line}`);
    console.error(`     ${(r.stderr || "").trim().split("\n")[0]}`);
  }
}

console.log(`lint-examples: ${examples.length} crust example(s) checked, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
