import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { test } from "node:test";
import { buildAllowedOrigins, canOpenBrowser, describeStartup, reachableAddresses, isExposed, isLoopback, isWildcard, lanAddress, lanAddresses, localAddress, parseHost, parseOrigin, urlHost, type Interfaces } from "./host";

const nic = (address: string, family: "IPv4" | "IPv6", internal = false) =>
  (family === "IPv4"
    ? { address, family, internal, netmask: "", mac: "", cidr: null }
    : { address, family, internal, netmask: "", mac: "", cidr: null, scopeid: 0 }) as NetworkInterfaceInfo;
const ifaces: Interfaces = {
  lo: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
  eth0: [nic("fe80::1", "IPv6"), nic("192.168.1.20", "IPv4"), nic("2001:db8::20", "IPv6")],
  tailscale0: [nic("100.64.0.7", "IPv4")],
};
const base = { port: 7420, interfaces: ifaces, hostname: "devbox" };

test("parseHost accepts IPs and localhost, rejects names and junk", () => {
  for (const h of ["0.0.0.0", "::", "127.0.0.1", "192.168.1.20", "::1", "fe80::1%eth0", "[::]"]) assert.ok(parseHost(h).ok, h);
  assert.deepEqual(parseHost("[::]"), { ok: true, host: "::" });
  assert.deepEqual(parseHost("localhost"), { ok: true, host: "127.0.0.1" });
  for (const h of ["", "  ", undefined, "example.com", "192.168.1", "0.0.0.0:7420", "999.1.1.1", "*"]) assert.equal(parseHost(h).ok, false, String(h));
});

test("loopback / wildcard / exposed", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) assert.ok(isLoopback(h), h);
  for (const h of ["0.0.0.0", "::", "192.168.1.20", "100.64.0.7"]) assert.ok(!isLoopback(h), h);
  assert.ok(isWildcard("0.0.0.0") && isWildcard("::") && !isWildcard("127.0.0.1"));
  assert.ok(!isExposed("127.0.0.1") && isExposed("0.0.0.0") && isExposed("10.0.0.5"));
});

test("urlHost brackets IPv6 and drops zones", () => {
  assert.equal(urlHost("192.168.1.20"), "192.168.1.20");
  assert.equal(urlHost("2001:db8::1"), "[2001:db8::1]");
  assert.equal(urlHost("fe80::1%eth0"), "[fe80::1]");
});

test("parseOrigin: exact origins only", () => {
  assert.deepEqual(parseOrigin("https://hq.example.com"), { ok: true, origin: "https://hq.example.com" });
  assert.deepEqual(parseOrigin("https://hq.example.com/"), { ok: true, origin: "https://hq.example.com" });
  assert.deepEqual(parseOrigin("HTTP://Host:8080"), { ok: true, origin: "http://host:8080" });
  for (const o of ["*", "null", "", "hq.example.com", "ftp://x", "https://x/path", "https://x?y=1", "https://u:p@x", "https://*.example.com"]) assert.equal(parseOrigin(o).ok, false, o);
});

test("lanAddresses: non-internal, IPv4 first, no link-local IPv6", () => {
  assert.deepEqual(lanAddresses(ifaces), ["192.168.1.20", "100.64.0.7", "2001:db8::20"]);
  assert.deepEqual(lanAddresses({}), []);
});

test("lanAddress / localAddress", () => {
  assert.equal(lanAddress("0.0.0.0", ifaces), "192.168.1.20");
  assert.equal(lanAddress("100.64.0.7", ifaces), "100.64.0.7");
  assert.equal(lanAddress("127.0.0.1", ifaces), null);
  assert.equal(lanAddress("::", {}), null);
  assert.equal(localAddress("0.0.0.0"), "127.0.0.1");
  assert.equal(localAddress("::"), "127.0.0.1");
  assert.equal(localAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(localAddress("192.168.1.20"), "192.168.1.20"); // 127.0.0.1 isn't listening then
});

test("default (loopback) origins are what HQ always allowed, and nothing from the network", () => {
  const o = buildAllowedOrigins({ ...base, host: "127.0.0.1", uiPort: 5173 }).sort();
  assert.deepEqual(o, ["http://127.0.0.1:5173", "http://127.0.0.1:7420", "http://localhost:7420"]);
  assert.ok(!o.some((x) => x.includes("192.168") || x.includes("devbox")));
});

test("--dev adds the Vite origins", () => {
  const o = buildAllowedOrigins({ ...base, host: "127.0.0.1", uiPort: 5173, dev: true });
  for (const x of ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:7420", "http://127.0.0.1:7420"]) assert.ok(o.includes(x), x);
});

test("0.0.0.0 allows each LAN address, the hostname and hostname.local, still exact origins", () => {
  const o = buildAllowedOrigins({ ...base, host: "0.0.0.0", uiPort: 5173 });
  for (const x of [
    "http://192.168.1.20:7420",
    "http://100.64.0.7:7420",
    "http://devbox:7420",
    "http://devbox.local:7420",
    "http://127.0.0.1:7420",
    "http://localhost:7420",
  ])
    assert.ok(o.includes(x), x);
  assert.ok(!o.includes("http://[fe80::1]:7420"));
  assert.ok(!o.includes("http://[2001:db8::20]:7420")); // not reachable on a 0.0.0.0 bind
  assert.ok(buildAllowedOrigins({ ...base, host: "::" }).includes("http://[2001:db8::20]:7420"));
  assert.ok(o.every((x) => /^https?:\/\/[^*/]+$/.test(x)), "no wildcards or paths");
  assert.ok(!o.includes("http://192.168.1.20:5173")); // only --dev serves the UI on the Vite port
});

test("a fully qualified hostname isn't given a .local twin; an IP-looking hostname is ignored", () => {
  const o = buildAllowedOrigins({ ...base, host: "0.0.0.0", hostname: "box.corp.example" });
  assert.ok(o.includes("http://box.corp.example:7420"));
  assert.ok(!o.some((x) => x.includes(".local")));
  assert.ok(!buildAllowedOrigins({ ...base, host: "0.0.0.0", hostname: "10.1.1.1" }).includes("http://10.1.1.1:7420"));
});

test("a specific interface IP allows that IP (and names), not every LAN address", () => {
  const o = buildAllowedOrigins({ ...base, host: "100.64.0.7" });
  assert.ok(o.includes("http://100.64.0.7:7420"));
  assert.ok(!o.includes("http://192.168.1.20:7420"));
});

test("--dev on the network allows the LAN address at Vite's port", () => {
  const o = buildAllowedOrigins({ ...base, host: "0.0.0.0", uiPort: 5173, dev: true });
  assert.ok(o.includes("http://192.168.1.20:5173"));
  assert.ok(o.includes("http://192.168.1.20:7420"));
});

test("a non-default loopback host is allowed as typed (::1)", () => {
  assert.ok(buildAllowedOrigins({ ...base, host: "::1" }).includes("http://[::1]:7420"));
});

test("--allow-origin values are added verbatim", () => {
  const o = buildAllowedOrigins({ ...base, host: "0.0.0.0", extra: ["https://hq.example.com"] });
  assert.ok(o.includes("https://hq.example.com"));
});

// ---------------------------------------------------------------- startup output

const T = "tok123";
const start = (host: string, over = {}) => describeStartup({ host, port: 7420, uiPort: 5173, dev: false, token: T, interfaces: ifaces, hostSource: null, ...over });

test("reachableAddresses", () => {
  assert.deepEqual(reachableAddresses("0.0.0.0", ifaces), ["192.168.1.20", "100.64.0.7"]); // 0.0.0.0 is IPv4 only
  assert.deepEqual(reachableAddresses("::", ifaces), ["192.168.1.20", "100.64.0.7", "2001:db8::20"]);
  assert.deepEqual(reachableAddresses("100.64.0.7", ifaces), ["100.64.0.7"]);
  assert.deepEqual(reachableAddresses("127.0.0.1", ifaces), []);
});

test("default run: loopback headline, a Listening line, no warning, nothing about --host", () => {
  const s = start("127.0.0.1");
  assert.equal(s.info, "\n\n  JSM HQ is running → http://127.0.0.1:7420/?token=tok123\n  Listening on 127.0.0.1:7420\n");
  assert.equal(s.warn, null);
  assert.equal(s.localUrl, "http://127.0.0.1:7420/?token=tok123");
});

test("--host 0.0.0.0: the headline is the first LAN URL, every other address is listed, loopback is mentioned last", () => {
  const s = start("0.0.0.0", { hostSource: "--host" });
  const lines = s.info.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(lines[0], "JSM HQ is running → http://192.168.1.20:7420/?token=tok123");
  assert.equal(lines[1], "Listening on 0.0.0.0:7420");
  assert.ok(s.info.includes("http://100.64.0.7:7420/?token=tok123"));
  assert.ok(!s.info.includes("2001:db8")); // IPv6 isn't reachable on 0.0.0.0
  assert.match(lines[lines.length - 1], /also on this machine: http:\/\/127\.0\.0\.1:7420\/\?token=tok123/);
  assert.ok(s.info.indexOf("192.168.1.20") < s.info.indexOf("127.0.0.1")); // the reachable URL comes first
  assert.match(s.warn ?? "", /remote shell/);
  assert.match(s.warn ?? "", /plain http/);
  assert.equal(s.localUrl, "http://127.0.0.1:7420/?token=tok123"); // the local tab never opens a LAN URL
});

test("--host with one interface address lists that URL only, and says nothing about loopback (it isn't listening)", () => {
  const s = start("100.64.0.7", { hostSource: "--host" });
  assert.ok(s.info.includes("JSM HQ is running → http://100.64.0.7:7420/?token=tok123"));
  assert.ok(!s.info.includes("127.0.0.1"));
  assert.ok(!s.info.includes("Other addresses"));
  assert.equal(s.localUrl, "http://100.64.0.7:7420/?token=tok123");
});

test("--host 0.0.0.0 with no network address falls back to the local URL and says so", () => {
  const s = start("0.0.0.0", { interfaces: {} });
  assert.ok(s.info.includes("JSM HQ is running → http://127.0.0.1:7420/"));
  assert.match(s.info, /No network address was found/);
  assert.ok(s.warn);
});

test("a host given but loopback is called out; an unset host is not", () => {
  assert.match(start("127.0.0.1", { hostSource: "HQ_HOST" }).info, /HQ_HOST 127\.0\.0\.1 is a loopback address.*only reachable from this machine/);
  assert.match(start("::1", { hostSource: "--host" }).info, /--host ::1 is a loopback address/);
  assert.ok(!start("127.0.0.1").info.includes("loopback address"));
});

test("--dev: URLs point at Vite's port and the warning says Vite must listen too", () => {
  const s = start("0.0.0.0", { dev: true, hostSource: "--host" });
  assert.ok(s.info.includes("→ http://192.168.1.20:5173/?token=tok123"));
  assert.match(s.info, /Listening on 0\.0\.0\.0:7420/); // HQ's own port
  assert.equal(s.localUrl, "http://localhost:5173/?token=tok123");
  assert.match(s.warn ?? "", /vite --host/);
  assert.equal(start("127.0.0.1", { dev: true }).warn, null);
});

test("IPv6 wildcard prints brackets in Listening and in URLs", () => {
  const s = start("::", { hostSource: "--host" });
  assert.ok(s.info.includes("Listening on [::]:7420"));
  assert.ok(s.info.includes("→ http://192.168.1.20:7420/"));
  assert.ok(s.info.includes("http://[2001:db8::20]:7420/?token=tok123")); // dual-stack: IPv6 works too
});

test("canOpenBrowser: headless Linux has no browser; macOS and Windows always try", () => {
  assert.equal(canOpenBrowser("linux", {}), false);
  assert.equal(canOpenBrowser("linux", { DISPLAY: ":0" }), true);
  assert.equal(canOpenBrowser("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
  assert.equal(canOpenBrowser("darwin", {}), true);
  assert.equal(canOpenBrowser("win32", {}), true);
});
