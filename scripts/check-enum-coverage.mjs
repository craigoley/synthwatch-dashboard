#!/usr/bin/env node
// Enum-coverage check — asserts every value in a runner-owned schema enum CHECK is covered by its consumer
// TS string-union, catching the ENUM-DRIFT class (a runner enum grows → the consumer union stays stale → a
// blind `as X` cast launders the new value past tsc → it breaks/mis-renders only in prod). Seen 3×:
// redaction_mismatch (#154 crash), grant gaps, spec_path — and live today: runs.status has 'infra_error'
// (since 0035) that RunStatus omitted.
//
// The ENUM sibling of pg-grant-coverage (synthwatch-api): same cross-repo static-parse harness, same fail-
// closed CI gate. A TS `never`-exhaustiveness check CANNOT catch this — the blind cast satisfies the compiler
// over the STALE union; it's a cross-repo contract gap, not an intra-repo one. So we parse the runner schema
// directly and diff it against the union.
//
//   RUNNER (source of truth) = `CHECK (<col> IN ('a','b',...))` in the runner repo's db/schema.sql. The
//     schema.sql is single-current-state (enum CHECKs are redefined per column), so the current CHECK is the
//     clean truth — NO migration-delta replay (unlike additive grants).
//   CONSUMER = `type <Union> = "a" | "b" | ...` parsed from the mapped file (per enum-coverage.json).
//   FAIL if any runner CHECK value is absent from its mapped union — naming the value(s) + table.column + union.
//
// Usage:  node scripts/check-enum-coverage.mjs [<runner-schema.sql>]
//   schema resolves from: arg -> $RUNNER_SCHEMA -> ./runner-repo/db/schema.sql (CI checkout)
//   -> ../synthwatch/db/schema.sql (local sibling). The CI workflow checks out craigoley/synthwatch first.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── pure parse helpers (exported for the contract must-go-red test) ────────────────────────────────────────

/** Strip `-- line` and block comments so a commented-out CHECK / prose enum list is never falsely parsed. */
export const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** The body of a `CREATE TABLE <table> ( ... \n);` block, or null if the table isn't found. */
export function tableBody(schemaText, table) {
  const clean = stripSqlComments(schemaText);
  // Non-greedy up to the first `\n);` — a table's terminating close is on its own line, whereas a CHECK's `)`
  // is inline, so this delimits the block without a full paren matcher.
  const re = new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?${table}"?\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, "i");
  const m = clean.match(re);
  return m ? m[1] : null;
}

/** The quoted values of `<column> IN ('a','b',...)` inside the given table, or null if not found. Handles the
 *  nullable form `CHECK (<col> IS NULL OR <col> IN (...))` too (it anchors on `<col> IN (`, not `CHECK (`). */
export function checkValues(schemaText, table, column) {
  const body = tableBody(schemaText, table);
  if (body == null) return null;
  const m = body.match(new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, "i"));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** The members of a TS string union `type <Union> = "a" | "b" | ...;`, or null if the type isn't found. */
export function unionValues(fileText, unionName) {
  const m = fileText.match(new RegExp(`type\\s+${unionName}\\s*=\\s*([^;]*);`));
  if (!m) return null;
  return [...m[1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]);
}

/**
 * Pure core: for each manifest mapping, diff the runner CHECK against the consumer union. `readFile(relPath)`
 * returns the file text (or null). Returns a finding per mapping with: the parsed sets, `missing` (CHECK
 * values absent from the union — the failure), and `unresolved` (schema/union that couldn't be parsed — also a
 * failure, so a broken manifest entry can't silently pass).
 */
export function computeCoverage(schemaText, manifest, readFile) {
  const findings = [];
  for (const [key, spec] of Object.entries(manifest)) {
    if (key.startsWith("$")) continue;
    const [table, column] = key.split(".");
    const checkVals = checkValues(schemaText, table, column);
    const fileText = readFile(spec.file);
    const unionVals = fileText == null ? null : unionValues(fileText, spec.union);
    const unresolved = [];
    if (checkVals == null) unresolved.push(`no CHECK for ${key} in the runner schema`);
    if (fileText == null) unresolved.push(`cannot read ${spec.file}`);
    else if (unionVals == null) unresolved.push(`no \`type ${spec.union}\` in ${spec.file}`);
    const missing = checkVals && unionVals ? checkVals.filter((v) => !unionVals.includes(v)) : [];
    findings.push({ key, table, column, union: spec.union, file: spec.file, checkVals, unionVals, missing, unresolved });
  }
  return findings;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "enum-coverage.json"), "utf8"));

  const schemaPath = [
    process.argv[2],
    process.env.RUNNER_SCHEMA,
    join(root, "runner-repo/db/schema.sql"),
    join(root, "../synthwatch/db/schema.sql"),
  ].filter(Boolean).find((p) => existsSync(p));
  if (!schemaPath) {
    console.error("::error::cannot find the runner schema.sql. Pass it as an arg, set $RUNNER_SCHEMA,");
    console.error("  or check out craigoley/synthwatch into ./runner-repo (the CI workflow does this).");
    process.exit(2);
  }

  const schemaText = readFileSync(schemaPath, "utf8");
  const readFile = (rel) => {
    const p = join(root, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const findings = computeCoverage(schemaText, manifest, readFile);

  const mapped = findings.length;
  console.log(`enum-coverage: ${mapped} mapping(s) checked against ${schemaPath.replace(root + "/", "")}`);

  const unresolved = findings.filter((f) => f.unresolved.length);
  const drifted = findings.filter((f) => f.missing.length);

  if (unresolved.length) {
    console.error("\n::error::UNRESOLVED MAPPING — an enum-coverage.json entry could not be parsed (fix the manifest):");
    for (const f of unresolved) console.error(`  - ${f.key} -> ${f.union}: ${f.unresolved.join("; ")}`);
  }
  if (drifted.length) {
    console.error("\n::error::ENUM DRIFT — a runner schema CHECK value is missing from its consumer union:");
    for (const f of drifted) {
      console.error(
        `  - ${f.missing.map((v) => `"${v}"`).join(", ")} in ${f.key} ` +
          `absent from type ${f.union} (${f.file}) — union has [${(f.unionVals ?? []).join(", ")}]`,
      );
    }
    console.error("  -> add the value(s) to the union AND any render/switch that maps it (the redaction_mismatch/#154 class).");
  }

  if (unresolved.length || drifted.length) process.exit(1);
  console.log("enum-coverage: OK — every runner CHECK value is covered by its consumer union.");
}

// Run as CLI only when invoked directly (so the contract test can import the pure helpers).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
