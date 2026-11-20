// jsm-hq — start HQ for the git repo you're in.
//
//   jsm-hq [--repo <path>] [--port 7420] [--host <addr>] [--allow-origin <origin>]... [--dev] [--no-open]
//
// --dev: the UI is served by Vite (pnpm dev:hq); HQ prints/opens the Vite URL.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCommands } from "./commands";
import { startHttp } from "./http";
import { Hub } from "./hub";
import { GitHubSync } from "./githubSync";
import { Inbox } from "./inbox";
import { Planner } from "./planner";
import { ActionItems } from "./actionItems";
import { Sbx } from "./sbx";
import { SbxMcp } from "./sbxMcp";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { ensurePtyHelperExecutable } from "./lib/ptyFix";
import { agentToken, browserToken } from "./paths";
import { hostname, networkInterfaces } from "node:os";
import { refreshProvider } from "./detect";
import { buildAllowedOrigins, canOpenBrowser, DEFAULT_HOST, describeStartup, isExposed, parseHost, parseOrigin } from "./host";
import { detectRepo } from "./repo";
import { Sessions } from "./sessions";
import { runSetupChecks } from "./setup";
import { loadConfig, loadPlan } from "./store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
/** Every value of a repeatable flag (`--allow-origin a --allow-origin b`). */
function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === `--${name}` && out.push(process.argv[i + 1] ?? ""));
  return out;
}

/** Where HQ listens. Read once, up front, so a bad value stops HQ with a clear message and errors can name the host. */
function listenSettings(): { port: number; host: string; extraOrigins: string[]; hostSource: "--host" | "HQ_HOST" | null } {
  const bad = (msg: string): never => {
    log.error(msg);
    process.exit(1);
  };
  const hostArg = arg("host") ?? process.env.HQ_HOST;
  const parsed = hostArg === undefined ? ({ ok: true, host: DEFAULT_HOST } as const) : parseHost(hostArg);
  if (!parsed.ok) return bad(parsed.error);
  const extraOrigins = argAll("allow-origin").map((o) => {
    const r = parseOrigin(o);
    return r.ok ? r.origin : bad(r.error);
  });
  const hostSource = arg("host") !== undefined ? "--host" : process.env.HQ_HOST !== undefined ? "HQ_HOST" : null;
  return { port: Number(arg("port") ?? process.env.HQ_PORT ?? 7420), host: parsed.host, extraOrigins, hostSource };
}
const settings = listenSettings();

async function main() {
  ensurePtyHelperExecutable();
  const dev = flag("dev");
  const { port, host, extraOrigins, hostSource } = settings;
  const repo = await detectRepo(resolve(arg("repo") ?? process.env.HQ_REPO ?? process.cwd()));
  const { config, isNew } = loadConfig(repo, port);
  config.project.hqPort = port;
  const slug = config.project.id;
  const token = agentToken(slug);
  const uiToken = browserToken(slug, dev);

  await refreshProvider(repo, config.project);
  const where = repo.provider ? `  (${repo.provider.info.baseUrl ?? repo.provider.info.host}/${repo.provider.info.repo}, ${repo.provider.info.name})` : "";
  log.info(`repo   ${repo.root}${where}`);
  log.info("checking setup…");
  const setup = await runSetupChecks(repo, config.team);
  for (const c of setup.checks) log.info(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.label}: ${c.detail}`);

  const hub = new Hub(repo, slug, config, loadPlan(repo.root), setup);
  hub.snap.welcome = isNew;
  const sessions = new Sessions(hub, token);
  const inbox = new Inbox(hub, { type: (id, text) => sessions.typeInto(id, text), enter: (id) => sessions.pressEnter(id) });
  sessions.onSessionDown = (id) => inbox.sessionDown(id);
  sessions.onSessionReattached = (id) => inbox.sessionReattached(id);
  sessions.lastHookAt = (id) => inbox.lastHookAt(id);
  const sbx = new Sbx(hub);
  sessions.envFileFor = (id) => (existsSync(sbx.envFile(id)) ? sbx.envFile(id) : null);
  const mcp = new SbxMcp(hub, (id, file, args, onExit) => sessions.runTerminal(id, file, args, onExit));
  sessions.onSandboxReady = (id) => {
    void sbx.syncRules(id);
    void mcp.attachAll(id);
    void sbx.refreshPorts(id);
  };
  sessions.onSessionDown = ((down) => (id: string) => {
    down(id);
    void sbx.refreshPorts(id);
  })(sessions.onSessionDown);
  sessions.onSandboxRemoved = (id) => {
    mcp.forget(id);
    void sbx.refreshPorts(id);
  };
  void sbx.refresh();
  void mcp.refresh();
  const planner = new Planner(hub, inbox);
  planner.actions = new ActionItems(hub, planner);

  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");
  const uiPort = Number(process.env.HQ_UI_PORT ?? 5173);
  if (!dev && !existsSync(join(distDir, "index.html"))) log.warn("No built UI found. Run `pnpm build` first, or use `pnpm dev:hq`.");

  const ifaces = networkInterfaces();
  const allowedOrigins = buildAllowedOrigins({ host, port, uiPort, dev, interfaces: ifaces, hostname: hostname(), extra: extraOrigins });
  if (!isExposed(host) && extraOrigins.length) log.warn("--allow-origin has no effect while HQ listens on loopback only; add --host to reach it from another device.");

  await startHttp({
    hub,
    inbox,
    planner,
    port,
    browserToken: uiToken,
    agentToken: token,
    distDir: dev ? null : distDir,
    host,
    allowedOrigins,
    commands: makeCommands(hub, sessions, planner, inbox, sbx, mcp),
  });
  sessions.startPolling();
  sbx.startApprovalPolling();
  const github = new GitHubSync(hub, planner);
  github.start();

  const startup = describeStartup({ host, port, uiPort, dev, token: uiToken, interfaces: ifaces, hostSource });
  log.info(startup.info);
  if (startup.warn) log.warn(startup.warn);
  // Open HQ's own tab on the local URL (never a LAN one). A headless Linux box has no browser: skip quietly.
  if (!flag("no-open") && canOpenBrowser(process.platform, process.env)) {
    const url = startup.localUrl;
    // Windows: rundll32 hands the URL to the default browser without a shell (the token has no special chars, but `&` would).
    const [opener, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    // Give Vite a moment in dev.
    setTimeout(() => void run(opener, args), dev ? 1500 : 0);
  }

  const quit = () => {
    log.info(sessions.backend.persistent ? "stopping HQ — agent sessions keep running in tmux" : "stopping HQ and its agents — sandboxes and folders are kept");
    sessions.shutdown();
    sbx.stopApprovalPolling();
    github.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`Port ${settings.port} on ${settings.host} is in use — another HQ may be running. Stop it, or pick another port: npx @therealjsmastery/jsm-hq --port 7421`);
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EACCES") {
    const port = settings.port;
    log.error(
      process.platform === "win32"
        ? `Windows reserved port ${port} (Hyper-V, WSL and Docker reserve port ranges). Pick another: npx @therealjsmastery/jsm-hq --port 8420\n  See the reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp`
        : `Not allowed to use port ${port} on ${settings.host}. Pick another: npx @therealjsmastery/jsm-hq --port 8420`,
    );
    process.exit(1);
  }
  if ((err as NodeJS.ErrnoException)?.code === "EADDRNOTAVAIL") {
    log.error(`${settings.host} isn't an address of this machine. Use 0.0.0.0 for every interface, or one of the addresses from \`ifconfig\` / \`ip addr\`.`);
    process.exit(1);
  }
  log.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
