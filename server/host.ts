// Where HQ listens and which browser origins may drive it. Pure functions (the
// machine's network interfaces and hostname are passed in) so they can be tested.

import { isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export const DEFAULT_HOST = "127.0.0.1";

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** `--host` / HQ_HOST: an IP address (v4 or v6; `0.0.0.0` and `::` mean every interface) or `localhost`. */
export function parseHost(input: string | undefined | null): { ok: true; host: string } | { ok: false; error: string } {
  const raw = input?.trim();
  if (!raw) return { ok: false, error: "--host needs an address, e.g. 0.0.0.0 (all interfaces) or a specific IP of this machine." };
  const host = raw.replace(/^\[(.*)\]$/, "$1");
  if (host.toLowerCase() === "localhost") return { ok: true, host: DEFAULT_HOST };
  if (isIP(host) === 0) return { ok: false, error: `--host must be an IP address such as 0.0.0.0, :: or 192.168.1.20 (got "${raw}"). Use --allow-origin for a custom name.` };
  return { ok: true, host };
}

export const isWildcard = (host: string) => host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "localhost") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/** True when other devices on the network can reach HQ. */
export const isExposed = (host: string) => !isLoopback(host);

/** An address as it appears in a URL: IPv6 in brackets, zone id dropped. */
export const urlHost = (host: string) => (isIP(host) === 6 ? `[${host.replace(/%.*$/, "")}]` : host);

/** Validates one `--allow-origin` value and returns it as a browser would send it (scheme://host[:port]). */
export function parseOrigin(input: string | undefined | null): { ok: true; origin: string } | { ok: false; error: string } {
  const raw = input?.trim();
  if (!raw) return { ok: false, error: "--allow-origin needs an origin, e.g. https://hq.example.com" };
  if (raw === "*" || raw === "null" || raw.includes("*")) return { ok: false, error: `--allow-origin can't be or contain a wildcard ("${raw}"): list the exact origins that may connect.` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `--allow-origin must look like https://hq.example.com (got "${raw}").` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `--allow-origin must start with http:// or https:// (got "${raw}").` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password)
    return { ok: false, error: `--allow-origin is just scheme://host[:port], without a path or credentials (got "${raw}").` };
  return { ok: true, origin: u.origin };
}

/** Non-internal addresses of this machine; IPv4 first, IPv6 link-local (fe80::) left out (browsers can't use them without a zone). */
export function lanAddresses(ifaces: Interfaces): string[] {
  const all = Object.values(ifaces).flatMap((l) => l ?? []).filter((i) => !i.internal);
  const v4 = all.filter((i) => i.family === "IPv4").map((i) => i.address);
  const v6 = all.filter((i) => i.family === "IPv6" && !i.address.toLowerCase().startsWith("fe80:")).map((i) => i.address);
  return [...new Set([...v4, ...v6])];
}

/** The address to put in the URL for other devices: the bound IP, or this machine's first LAN address. Null if there is none. */
export function lanAddress(host: string, ifaces: Interfaces): string | null {
  if (!isWildcard(host)) return isLoopback(host) ? null : host;
  return lanAddresses(ifaces)[0] ?? null;
}

/** The address HQ's own browser tab uses: loopback unless HQ is bound to one specific other address. */
export const localAddress = (host: string) => (isWildcard(host) || isLoopback(host) ? DEFAULT_HOST : host);

export interface OriginInput {
  host: string;
  port: number;
  /** Vite's port; in --dev the UI is served there, so browsers send that origin. */
  uiPort?: number;
  dev?: boolean;
  interfaces: Interfaces;
  hostname: string;
  /** Validated `--allow-origin` values. */
  extra?: string[];
}

/**
 * Exact origins allowed to open the console's WebSocket. Loopback only by default (as before);
 * when HQ is reachable from the network, also the addresses and names the other device will type.
 */
export function buildAllowedOrigins(i: OriginInput): string[] {
  const ports = i.dev && i.uiPort ? [i.port, i.uiPort] : [i.port];
  const origins = new Set<string>();
  const add = (host: string) => ports.forEach((p) => origins.add(`http://${host}:${p}`));

  // What HQ always allowed: its own port on loopback, and Vite's port.
  ["127.0.0.1", "localhost"].forEach((h) => origins.add(`http://${h}:${i.port}`));
  if (i.uiPort) {
    origins.add(`http://127.0.0.1:${i.uiPort}`);
    if (i.dev) origins.add(`http://localhost:${i.uiPort}`);
  }

  if (!isWildcard(i.host)) add(urlHost(i.host)); // the explicit host (also covers a non-default loopback like ::1)
  if (isExposed(i.host)) {
    if (isWildcard(i.host)) lanAddresses(i.interfaces).forEach((a) => add(urlHost(a)));
    const name = i.hostname.trim().toLowerCase();
    if (name && !isIP(name)) {
      add(name);
      if (!name.includes(".")) add(`${name}.local`);
    }
  }
  for (const o of i.extra ?? []) origins.add(o);
  return [...origins];
}
