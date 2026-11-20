#!/usr/bin/env node
// jsm-hq — run JSM HQ for the git repo you're in.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`JSM HQ ${pkg.version} — a pixel office for your team of AI coding agents.

Usage:
  npx @therealjsmastery/jsm-hq [options]          run inside a git repo

Options:
  --repo <path>   the git repo to manage (default: current folder)
  --port <n>      HQ server port (default: 7420)
  --host <addr>   address to listen on (default: 127.0.0.1, this machine only; env: HQ_HOST).
                  0.0.0.0 or :: = every network interface, or one IP of this machine.
                  This lets other devices open the console, including its terminals:
                  read "Use from another device" in the README first.
  --allow-origin <origin>
                  also accept browsers opened from this origin, e.g. https://hq.example.com
                  (for a reverse proxy or custom name; repeatable; needs --host)
  --no-open       don't open the browser
  -v, --version   print the version
  -h, --help      show this help

Needs: Docker Sandboxes (sbx) or Claude Code/Codex, tmux, git, gh.
HQ checks all of this on start and shows how to fix anything missing.
Docs: ${pkg.homepage ?? "https://github.com/jsmastery-pro/jsm-hq"}`);
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`JSM HQ needs Node.js 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

// Check option values here so a typo gets a clear message instead of a silent default.
const fail = (msg) => {
  console.error(`jsm-hq: ${msg}\nRun "npx @therealjsmastery/jsm-hq --help" for usage.`);
  process.exit(1);
};
const isHost = (v) => v.toLowerCase() === "localhost" || isIP(v.replace(/^\[(.*)\]$/, "$1")) !== 0;
const isOrigin = (v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username;
  } catch {
    return false;
  }
};
if (process.env.HQ_HOST !== undefined && !isHost(process.env.HQ_HOST.trim())) fail(`HQ_HOST must be an IP address such as 0.0.0.0, :: or 192.168.1.20 (got "${process.env.HQ_HOST}").`);
for (const name of ["--repo", "--port", "--host", "--allow-origin"]) {
  args.forEach((a, i) => {
    if (a !== name) return;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) fail(`${name} needs a value.`);
    if (name === "--host" && !isHost(value)) fail(`--host must be an IP address such as 0.0.0.0, :: or 192.168.1.20 (got "${value}").`);
    if (name === "--allow-origin" && !isOrigin(value)) fail(`--allow-origin must look like https://hq.example.com (got "${value}").`);
  });
  const i = args.indexOf(name);
  if (i === -1 || name === "--host" || name === "--allow-origin") continue;
  const value = args[i + 1];
  if (name === "--port" && !(/^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535)) fail(`--port must be a number from 1024 to 65535 (got "${value}").`);
}

await import("../dist-server/main.mjs");
