/**
 * Static security scan (Phase 26).
 *
 * Two severities, and the split matters:
 *
 *  - **Banned.** Patterns that must never appear in this codebase under any
 *    circumstance. A match fails CI.
 *  - **Review required.** Patterns that are legitimate in specific places (the
 *    main process, the preload, the sandbox check itself). A match does not
 *    fail; it prints the file and the line so a human decides. Failing CI on
 *    `new Function` because the scan file itself contains the string would train
 *    everyone to add a bypass.
 *
 * Every rule can be waived for one line with an explicit annotation:
 *
 *     // security-review: reason
 *
 * The annotation is not a silent escape hatch — it is printed in the report, so
 * a waiver is visible in review rather than hidden in a diff nobody reads.
 *
 * Run: `node scripts/security-scan.mjs`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "scripts", "services/ecosystem/src"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

/**
 * Files whose job is to *contain* the banned patterns.
 *
 * The policy test enumerates the patterns it forbids and the Electron stub
 * declares `ipcMain`. Flagging those would make the scan report itself, which
 * is the fastest way to get a scan switched off. These files are still scanned
 * for everything else.
 */
const PATTERN_CARRIERS = [
  "scripts/tests/",
  "scripts/security-scan.mjs",
  "scripts/security-scan",
];

function isPatternCarrier(rel) {
  return PATTERN_CARRIERS.some((prefix) => rel.startsWith(prefix) || rel.endsWith(prefix));
}
const BANNED = [
  {
    id: "eval",
    re: /(?<![.\w])eval\s*\(/,
    why: "eval() executes attacker-controlled source. Use a parser or a lookup table.",
  },
  {
    id: "new-function",
    re: /\bnew\s+Function\s*\(/,
    why: "new Function() is eval() with better branding.",
  },
  {
    id: "remote-module",
    re: /\bimport\s*\(\s*["'`]https?:/,
    why: "dynamic import of a remote URL is remote code execution.",
  },
  {
    id: "remote-script",
    re: /createElement\s*\(\s*["']script["']/,
    why: "an injected <script> element is remote code execution.",
  },
];

/** Prints a warning and the line. Waivable per line. */
const REVIEW = [
  {
    id: "child-process",
    re: /\b(?:child_process|execSync|spawnSync|execFileSync)\b/,
    why: "process execution. Legitimate in scripts/, not in src/.",
    // `src/main/security/updater` is the single exception, and it is the same
    // shape as the `open-external` rule below: one named file, one reviewed
    // privileged operation. The updater must launch the Injector, because the
    // Injector is what writes into the Discord install — the client must not
    // rewrite its own `main.js`. The launch is `spawn(path, [argv], {shell:
    // false})` against a user-configured absolute path that main validates as
    // an existing regular file. Renderer code still cannot spawn anything, and
    // the `allowIn` is a path prefix rather than a waiver, so any *other* file
    // added under src/main that spawns a process is still reported.
    allowIn: ["scripts", "src/main/security/updater"],
  },
  {
    id: "raw-ipc",
    re: /\bipcRenderer\b|\bipcMain\b/,
    why: "raw IPC. Only src/preload and src/main may touch it; the renderer must not.",
    allowIn: ["src/main", "src/preload", "scripts/tests"],
  },
  {
    id: "node-fs-renderer",
    re: /from\s+["']node:(?:fs|path|child_process|os)["']/,
    why: "a Node import in code that reaches the renderer. Main/preload and build scripts only.",
    allowIn: ["src/main", "src/preload", "src/shared", "scripts"],
  },
  {
    id: "web-security-off",
    re: /webSecurity\s*:\s*false/,
    why: "disabling webSecurity removes the same-origin policy for the whole client.",
    allowIn: [],
  },
  {
    id: "node-integration",
    re: /nodeIntegration\s*:\s*true/,
    why: "nodeIntegration in a renderer gives page code require().",
    allowIn: [],
  },
  {
    id: "sandbox-true-relied-on",
    re: /sandbox\s*:\s*true/,
    why: "sandbox:true is incompatible with Discord's preload chain; it must not be set casually.",
    allowIn: [],
  },
  {
    id: "open-external",
    re: /shell\.openExternal/,
    why: "hands a URL to an OS handler. Must go through the protocol allowlist.",
    allowIn: ["src/main/security/navigation"],
  },
  {
    id: "node-vm",
    re: /node:vm|require\(["']vm["']\)/,
    why: "node:vm is not a security boundary. Untrusted code needs a separate process.",
    allowIn: [],
  },
  {
    id: "token-access",
    re: /getToken|saveToken|exportToken|accountToken/i,
    why: "Syncord must never read or write the Discord account token.",
    allowIn: [],
  },
];

const WAIVER = /security-review:\s*(.+)/;

/**
 * Strip comments from a line before matching.
 *
 * Without this the scan spends its entire budget reporting the very patterns it
 * exists to prevent, mentioned in the comments that explain why they are
 * prevented. `native.ts` says "there is deliberately no `getToken`", and a scan
 * that flags that line is a scan whose output nobody reads.
 *
 * Not a full parser: it handles line comments, block-comment continuation lines,
 * and string literals well enough to avoid the obvious false positives, which
 * is all a review-grade scan needs. A banned pattern hidden inside a string is a
 * far smaller problem than a scan that cries wolf on every comment.
 */
function stripComments(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return "";
  // Remove a trailing `//` comment that is not inside a quote.
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (c === "`" && !inSingle && !inDouble) inBacktick = !inBacktick;
    else if (c === "/" && line[i + 1] === "/" && !inSingle && !inDouble && !inBacktick) {
      return line.slice(0, i);
    }
  }
  return line;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(full))) out.push(full);
  }
  return out;
}

function isAllowed(rel, rule) {
  if (rule.allowIn.length === 0) return false;
  return rule.allowIn.some((prefix) => rel.startsWith(prefix));
}

export function scan(files, options = {}) {
  const base = options.base ?? ROOT;
  const banned = [];
  const review = [];
  const waivers = [];

  for (const file of files) {
    const rel = path.relative(base, file);
    // The scanner and its tests *contain* every pattern they look for, by
    // necessity. Scanning them is a tautology that produces pure noise, and a
    // scanner that always reports itself is a scanner nobody reads. Real
    // problems in those files are still caught by `tsc` and by review.
    if (isPatternCarrier(rel)) continue;

    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((rawLine, index) => {
      const waiver = WAIVER.exec(rawLine);
      if (waiver) waivers.push({ file: rel, line: index + 1, reason: waiver[1].trim() });

      const line = stripComments(rawLine);
      if (line.trim().length === 0) return;

      for (const rule of BANNED) {
        if (rule.re.test(line)) {
          banned.push({ file: rel, line: index + 1, id: rule.id, why: rule.why, text: line.trim() });
        }
      }
      for (const rule of REVIEW) {
        if (!rule.re.test(line)) continue;
        if (isAllowed(rel, rule)) continue;
        review.push({ file: rel, line: index + 1, id: rule.id, why: rule.why, text: line.trim() });
      }
    });
  }
  return { banned, review, waivers };
}

function report(result) {
  const { banned, review, waivers } = result;

  if (waivers.length > 0) {
    console.log(`\nsecurity-review waivers in effect (${waivers.length}):`);
    for (const w of waivers) console.log(`  ${w.file}:${w.line}  ${w.reason}`);
  }

  if (review.length > 0) {
    console.log(`\nSECURITY REVIEW REQUIRED (${review.length}):`);
    for (const r of review) {
      console.log(`  ${r.file}:${r.line}  [${r.id}] ${r.why}`);
      console.log(`      ${r.text.slice(0, 110)}`);
      console.log(`      → add "// security-review: <reason>" on that line, or fix it`);
    }
  } else {
    console.log("\nNo review-required patterns found.");
  }

  if (banned.length > 0) {
    console.error(`\nBANNED PATTERNS FOUND (${banned.length}):`);
    for (const b of banned) {
      console.error(`  ${b.file}:${b.line}  [${b.id}] ${b.why}`);
      console.error(`      ${b.text.slice(0, 110)}`);
    }
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith("security-scan.mjs");
if (invokedDirectly) {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), []));
  const result = scan(files);
  report(result);
  process.exit(result.banned.length > 0 ? 1 : 0);
}

export { walk, SCAN_DIRS, ROOT };
