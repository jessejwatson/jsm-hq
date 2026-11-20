// Works out which git host the project's PRs live on, and builds its Provider.
// github.com → GitHub. Any other host → probe <base>/api/v1/version for Gitea/Forgejo.
// Settings → Project can override both the provider and the server address.

import type { ProjectConfig, ProviderInfo } from "../src/data/types";
import { giteaProvider } from "./gitea";
import { githubProvider } from "./github";
import { log } from "./lib/log";
import type { Provider } from "./provider";
import { isGithubHost, normalizeBaseUrl, parseRemote, repoPath, webBase, type Remote } from "./remote";

type Fetch = typeof fetch;
const PROBE_TIMEOUT_MS = 4000;

/** Forgejo reports e.g. "8.0.0+gitea-1.22.0"; Gitea reports a plain "1.22.0". */
export const isForgejo = (version: string) => /forgejo|[+-]gitea-/i.test(version);

/** GET <base>/api/v1/version: the server's version, or null when it isn't a Gitea/Forgejo API. */
export async function probeGitea(base: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${base}/api/v1/version`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version ? body.version : null;
  } catch {
    return null;
  }
}

export interface Detected {
  provider: Provider | null;
  /** Why no provider was found (shown in the setup checklist). */
  reason: string | null;
}

/** Candidate web addresses for a remote: its own for http(s); for ssh, https then http on the default ports. */
function bases(remote: Remote): string[] {
  if (remote.protocol !== "ssh") return [webBase(remote)];
  const host = remote.host.includes(":") ? `[${remote.host}]` : remote.host;
  return [`https://${host}`, `http://${host}`];
}

export async function resolveProvider(
  originUrl: string | null,
  project: Pick<ProjectConfig, "provider" | "baseUrl">,
  fetchImpl: Fetch = fetch,
): Promise<Detected> {
  const remote = parseRemote(originUrl);
  const mode = project.provider ?? "auto";
  const override = normalizeBaseUrl(project.baseUrl);

  if (mode === "github" || (mode === "auto" && (remote && isGithubHost(remote.host)))) {
    if (!remote) return { provider: null, reason: originUrl ? `origin is ${originUrl}, which HQ can't read as owner/name` : "No origin remote." };
    return { provider: githubProvider(repoPath(remote)), reason: null };
  }

  if (!remote) return { provider: null, reason: originUrl ? `origin is ${originUrl}, which HQ can't read as owner/name` : "No origin remote." };
  const repo = repoPath(remote);

  const make = (baseUrl: string, version: string | null, source: ProviderInfo["source"]): Detected => {
    const host = new URL(baseUrl).host;
    const info: ProviderInfo = { kind: "gitea", name: version && isForgejo(version) ? "Forgejo" : "Gitea", baseUrl, host, repo, source };
    return { provider: giteaProvider(info), reason: null };
  };

  if (mode === "gitea") {
    // Trust the user: a failed probe only costs the Forgejo/Gitea label.
    const base = override ?? bases(remote)[0];
    return make(base, await probeGitea(base, fetchImpl), "override");
  }

  // auto, not github.com
  if (override) return make(override, await probeGitea(override, fetchImpl), "override");
  const tried = bases(remote);
  for (const base of tried) {
    const version = await probeGitea(base, fetchImpl);
    if (version) return make(base, version, "probe");
  }
  return {
    provider: null,
    reason: `origin is ${originUrl} (not GitHub), and ${tried.map((b) => `${b}/api/v1/version`).join(" / ")} didn't answer like Gitea or Forgejo. Set the provider and server address in Settings → Project.`,
  };
}

/** The signature that says whether a provider needs rebuilding. */
export const providerKey = (p: ProviderInfo | null) => (p ? `${p.kind}|${p.baseUrl ?? ""}|${p.repo}` : "none");

/** Re-resolves hub.repo's provider from the saved project settings. Returns true when it changed. */
export async function refreshProvider(repo: { originUrl: string | null; provider: Provider | null; providerReason: string | null }, project: ProjectConfig): Promise<boolean> {
  const before = providerKey(repo.provider?.info ?? null);
  const found = await resolveProvider(repo.originUrl, project);
  repo.provider = found.provider;
  repo.providerReason = found.reason;
  const after = providerKey(found.provider?.info ?? null);
  if (found.provider && before !== after) log.info(`PRs: ${found.provider.info.name} · ${found.provider.info.baseUrl ?? found.provider.info.host} · ${found.provider.info.repo}`);
  return before !== after;
}
