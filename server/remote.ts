// Parses a git remote URL (https, http, ssh://, or scp-style git@host:owner/name)
// into the pieces HQ needs to find the repo's PRs. Pure: no I/O.

export interface Remote {
  protocol: "https" | "http" | "ssh";
  host: string; // lower-case, no port
  port: number | null; // the URL's port (for ssh this is the SSH port, not the web port)
  owner: string;
  name: string;
  /** Path in front of owner/name when the server lives under a subpath (https://host/git/owner/name). */
  subpath: string;
}

/** Strips a trailing `.git` and slashes. */
const clean = (path: string) => path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");

function fromPath(protocol: Remote["protocol"], host: string, port: number | null, rawPath: string): Remote | null {
  const parts = clean(rawPath).split("/").filter(Boolean);
  if (parts.length < 2 || !host) return null;
  const name = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  // ssh paths are always owner/name relative to the server; only a web URL can carry a subpath.
  const subpath = protocol === "ssh" ? "" : parts.slice(0, -2).join("/");
  return { protocol, host: host.toLowerCase(), port, owner, name, subpath: subpath ? `/${subpath}` : "" };
}

export function parseRemote(url: string | null | undefined): Remote | null {
  const u = url?.trim();
  if (!u) return null;
  const scheme = u.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    const s = scheme[1].toLowerCase();
    const protocol = s === "https" ? "https" : s === "http" ? "http" : s === "ssh" || s === "git+ssh" || s === "ssh+git" ? "ssh" : null;
    if (!protocol) return null; // git://, file://, …
    return fromPath(protocol, parsed.hostname.replace(/^\[|\]$/g, ""), parsed.port ? Number(parsed.port) : null, decodeURIComponent(parsed.pathname));
  }
  // scp-style: [user@]host:path (not a Windows drive like C:\repo, and the path has no leading //)
  const scp = u.match(/^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]{2,}):(?!\/\/)(.+)$/);
  if (scp) return fromPath("ssh", scp[1].replace(/^\[|\]$/g, ""), null, scp[2].replace(/^\/+/, ""));
  return null;
}

export const repoPath = (r: Remote) => `${r.owner}/${r.name}`;

/** Where the server's web UI and API live, from an https/http remote or, for ssh, assuming https on the default port. */
export function webBase(r: Remote): string {
  const proto = r.protocol === "http" ? "http" : "https";
  const port = r.protocol === "ssh" || !r.port ? "" : `:${r.port}`;
  return `${proto}://${r.host.includes(":") ? `[${r.host}]` : r.host}${port}${r.subpath}`;
}

/** Normalises a user-typed server address: adds https://, drops a trailing `/` and `/api/v1`. Null when unusable. */
export function normalizeBaseUrl(input: string | null | undefined): string | null {
  let s = input?.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

/** github.com, including the ssh-over-443 host. */
export const isGithubHost = (host: string) => host === "github.com" || host === "ssh.github.com";
