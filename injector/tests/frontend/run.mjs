/**
 * Frontend DOM test for the Injector.
 *
 * Run: `node injector/tests/frontend/run.mjs`
 *
 * Drives the **real** `ui/app.js` and `ui/styles.css` in headless Chrome and
 * asserts what a user would see: the three status states, the buttons each
 * state offers, the confirmation dialog, the toast, and the empty and
 * payload-missing states.
 *
 * The seam under test is `window.__TAURI__.core.invoke`, because that is the
 * entire boundary between the frontend and Rust. The stubbed responses are the
 * exact JSON shapes `state.rs` serialises, so this checks the *contract* rather
 * than a fixture somebody invented. `state_contract.mjs` separately asserts
 * that the command names and field names on both sides of that boundary agree,
 * because a typo there would render a window that does nothing and no DOM test
 * would notice.
 *
 * Chromium is driven over HTTP rather than `file://` because ES module imports
 * from a `file://` origin are blocked as cross-origin.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECTOR_ROOT = path.resolve(HERE, "..", "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  ...(process.platform === "win32" ? [
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ] : []),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":"image/png",
  ".svg":"image/svg+xml",
};

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** Resolve a request path inside a permitted root, or refuse it. */
function resolveWithin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.resolve(root, `.${decoded}`);
  // The server is bound to localhost and used for a test that loads no remote
  // content, but a path check costs nothing and makes the intent explicit.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function main() {
  const chrome = findChrome();
  const electron=["Electron.app/Contents/MacOS/Electron","electron.exe","electron"].map(name=>path.join(INJECTOR_ROOT,"..","node_modules/electron/dist",name)).find(existsSync);
  if (!electron && chrome === null) {
    console.error("[frontend] no Chrome/Chromium binary found; set one in CHROME_CANDIDATES.");
    process.exit(1);
  }

  // Two roots: the harness, and the real `src-tauri` tree it loads from.
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const root = url.startsWith("/app/") ? INJECTOR_ROOT : HERE;
    const rel = url.startsWith("/app/") ? url.slice("/app".length) : url;

    const file = resolveWithin(root, rel === "/" ? "/harness.html" : rel);
    if (file === null) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/harness.html`;
  console.log(`[frontend] serving ${url}`);

  const dom = await new Promise((resolve, reject) => {
    const child = spawn(
      electron ?? chrome,
      electron ? [path.join(HERE,"electron-driver.cjs"),url] : [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--no-first-run",
        "--virtual-time-budget=30000",
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env:{...process.env,ELECTRON_RUN_AS_NODE:""} },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    setTimeout(() => child.kill("SIGKILL"), 60_000).unref();
  });

  server.close();

  const match = /<div id="harness-out">([\s\S]*?)<\/div>/.exec(dom);
  const report = match ? unescapeHtml(match[1]) : null;

  if (report === null) {
    console.error("[frontend] the harness produced no output — app.js did not run.");
    console.error(dom.slice(0, 2000));
    process.exit(1);
  }

  console.log(report);
  const lines = report.split("\n").filter(Boolean);
  const failed = lines.filter((line) => line.startsWith("FAIL"));

  if (lines.some((line) => line.includes("running…"))) {
    console.error("\nFAIL the harness stopped before finishing");
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`\nFAIL ${failed.length} of ${lines.length} frontend assertions`);
    process.exit(1);
  }

  const passed = /(\d+)\/(\d+) passed/.exec(report);
  if(!passed){console.error("FAIL: frontend harness did not finish");process.exit(1);}
  console.log(`\nPASS: ${passed[1]} frontend assertions`);
}

function unescapeHtml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&");
}

await main();
