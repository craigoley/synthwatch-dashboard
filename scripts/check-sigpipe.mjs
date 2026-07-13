#!/usr/bin/env node
// Fail-closed static check for the SIGPIPE FAIL-OPEN class (seen 4×: #275/#279/#281/#283).
//
// THE BUG: `<streaming-writer> | grep -q PAT` (or `| grep -m1`, `| head -n1`) under `set -o pipefail`. The
// early-exit consumer (grep -q stops on the FIRST match; head stops after N lines) closes the pipe while the
// writer is STILL streaming → the writer takes SIGPIPE → the pipeline exits 141 → under pipefail the whole
// command "fails". When that command is a GATE (`if <pipeline>; then BLOCK`), a MATCH (which should BLOCK)
// instead throws non-zero and — if wrapped in `|| true` / an `if !` — flips to the FAIL-OPEN branch. A BLOCK
// silently becomes a PASS, only on LARGE inputs (small ones finish before grep -q closes → passes in tests).
//
// THE FIX: a here-string, never a pipe — `grep -qE PAT <<<"$x"` (no writer to SIGPIPE), or `if/then` without
// the pipe. This scanner bans the piped form in workflow `run:` blocks + shell scripts so the next one fails
// at AUTHOR TIME, not at 2am when a big diff flips a BLOCK to a merge.
//
// Suppress a proven-safe line with a trailing `# sigpipe-ok: <reason>` (e.g. a fixed tiny producer). An
// unexplained suppression is how the class returns, so the reason is mandatory.
//
// SAFE by construction (NOT flagged): `grep -o … | tail -1` (both read to EOF — no early close), and any
// `grep -q … <<<"$x"` here-string (no piped writer). Only the PIPED early-exit consumer is the bug.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// Files that can contain shell pipelines: workflow YAML (`run:` blocks) + shell scripts.
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === ".next" || e === ".worktrees") continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ya?ml|sh|bash)$/.test(e)) out.push(p);
  }
  return out;
}

// A pipe `|` immediately feeding an EARLY-EXIT consumer: grep with a -q or -m flag, or head. `[^|]` before
// the `|` avoids matching a `||` (logical OR, not a pipe). We do NOT flag `grep -o`/`grep -c`/plain `grep`
// (they read to EOF), nor here-strings (`<<<`, no pipe).
const DANGER = /[^|]\|\s*(grep\s+-\S*[qm]\b|grep\s+--(quiet|silent|max-count)|head\b)/;

const offenders = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/#\s*sigpipe-ok:/.test(line)) return; // explicit, justified carve-out (checked on the raw line)
    // Strip a shell comment (a `#` at line-start or after whitespace) so a comment that QUOTES the bad
    // pattern to explain the fix — e.g. self-heal.yml's "here-string, not `printf | grep -q`" — isn't flagged.
    const code = line.replace(/(^|\s)#.*$/, "$1");
    if (!DANGER.test(code)) return;
    offenders.push({ file: file.replace(ROOT + "/", ""), line: i + 1, text: line.trim() });
  });
}

if (offenders.length) {
  console.error("SIGPIPE fail-open risk — a piped early-exit consumer (grep -q/-m, head) can SIGPIPE its");
  console.error("writer on a large input and flip a BLOCK to a fail-open PASS. Use a here-string:");
  console.error('  BAD:  printf "%s" "$x" | grep -q PAT');
  console.error('  GOOD: grep -qE PAT <<<"$x"      # no piped writer → no SIGPIPE');
  console.error("(or `# sigpipe-ok: <reason>` on the line if the producer is provably tiny/fixed)\n");
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
  process.exit(1);
}

console.log("SIGPIPE guard: no piped early-exit consumers (grep -q/-m, head) in workflows or shell scripts.");
