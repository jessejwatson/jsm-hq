// Gitea / Forgejo: plain REST against <base>/api/v1 (the two share one API).
// Responses are normalised into the GhPr shape so reviewOf, toPullRequest and
// the sync loop work the same as for GitHub.

import type { GhPr } from "./github";
import { RateLimited } from "./github";
import type { PrPage, Provider } from "./provider";
import type { ProviderInfo } from "../src/data/types";

// ---------------------------------------------------------------- API shapes (only what we read)

export interface GtUser {
  login?: string;
}
export interface GtPull {
  number: number;
  title: string;
  html_url: string;
  state: string; // "open" | "closed"
  merged?: boolean;
  merged_at?: string | null;
  created_at: string;
  mergeable?: boolean;
  draft?: boolean;
  head: { ref: string; sha?: string };
}
export interface GtReview {
  id: number;
  user?: GtUser | null;
  state: string; // APPROVED | REQUEST_CHANGES | COMMENT | PENDING | REQUEST_REVIEW
  submitted_at?: string | null;
  dismissed?: boolean;
  comments_count?: number;
}
export interface GtReviewComment {
  user?: GtUser | null;
  resolver?: GtUser | null;
  position?: number;
  original_position?: number;
}
export interface GtStatus {
  context?: string;
  status?: string; // success | pending | failure | error | warning
  description?: string | null;
}

// ---------------------------------------------------------------- normalisation (pure)

const REVIEW_STATE: Record<string, string | undefined> = { APPROVED: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

const WIP = /^\s*(\[wip\]|wip:)/i;

/** Gitea status → the GitHub StatusContext states reviewOf understands. */
const STATUS: Record<string, string> = { success: "SUCCESS", pending: "PENDING", failure: "FAILURE", error: "ERROR", warning: "FAILURE" };

export function giteaReviews(reviews: GtReview[]): GhPr["reviews"]["nodes"] {
  return reviews
    // Unsubmitted drafts and review requests aren't reviews yet.
    .filter((r) => r.state !== "PENDING" && r.state !== "REQUEST_REVIEW")
    .map((r) => ({
      author: r.user?.login ? { login: r.user.login } : null,
      state: r.dismissed ? "DISMISSED" : (REVIEW_STATE[r.state] ?? r.state),
      submittedAt: r.submitted_at ?? "",
    }))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

/** Newest verdict per reviewer (a dismissal clears it): any outstanding change request wins, else any approval. */
export function giteaDecision(nodes: GhPr["reviews"]["nodes"]): GhPr["reviewDecision"] {
  const latest = new Map<string, string>();
  for (const r of nodes) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.login, r.state);
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return null;
}

/** Each review comment counts as one thread; "resolved" is Gitea's resolver, "outdated" a comment whose line moved away. */
export function giteaThreads(comments: GtReviewComment[]): GhPr["reviewThreads"]["nodes"] {
  return comments.map((c) => ({
    isResolved: !!c.resolver,
    isOutdated: c.position === 0 && (c.original_position ?? 0) > 0,
    comments: { nodes: [{ author: c.user?.login ? { login: c.user.login } : null }] },
  }));
}

type Contexts = NonNullable<GhPr["commits"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"]["nodes"];

export function giteaContexts(statuses: GtStatus[]): Contexts {
  return statuses.map((s) => ({
    __typename: "StatusContext" as const,
    context: s.context ?? "",
    state: STATUS[(s.status ?? "").toLowerCase()] ?? "PENDING",
    description: s.description ?? null,
  }));
}

export interface PullExtras {
  reviews?: GtReview[];
  comments?: GtReviewComment[];
  statuses?: GtStatus[] | null;
}

/** One Gitea pull request (plus its reviews, review comments and commit statuses) as a GhPr. */
export function giteaToGhPr(pr: GtPull, extra: PullExtras = {}): GhPr {
  const merged = !!pr.merged;
  const state: GhPr["state"] = merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
  const reviews = giteaReviews(extra.reviews ?? []);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    headRefName: pr.head?.ref ?? "",
    createdAt: pr.created_at,
    mergedAt: pr.merged_at ?? null,
    state,
    // Gitea only says whether it can merge; "false" mostly means conflicts.
    mergeable: state !== "OPEN" || pr.mergeable === undefined ? "UNKNOWN" : pr.mergeable ? "MERGEABLE" : "CONFLICTING",
    isDraft: !!pr.draft || WIP.test(pr.title),
    reviewDecision: giteaDecision(reviews),
    reviews: { nodes: reviews },
    reviewThreads: { nodes: giteaThreads(extra.comments ?? []) },
    commits: { nodes: extra.statuses ? [{ commit: { statusCheckRollup: { contexts: { nodes: giteaContexts(extra.statuses) } } } }] : [] },
  };
}

// ---------------------------------------------------------------- client

export const GITEA_TOKEN_ENV = ["GITEA_TOKEN", "FORGEJO_TOKEN"] as const;
export const giteaToken = (env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const k of GITEA_TOKEN_ENV) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return null;
};

type Fetch = typeof fetch;
const OPEN_LIMIT = 20;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;

export class GiteaClient {
  constructor(private base: string, private token: () => string | null = giteaToken, private fetchImpl: Fetch = fetch) {}

  /** GET <base>/api/v1/<path>. Throws RateLimited on 429, a readable Error on other failures. */
  async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = this.token();
    if (token) headers.Authorization = `token ${token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/v1${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
      throw new Error(`Can't reach ${this.base} (${why})`);
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      throw new RateLimited(new Date(Date.now() + (Number.isFinite(wait) && wait > 0 ? wait * 1000 : 60_000)));
    }
    if (res.status === 401) throw new Error(`Gitea rejected the token (401). Check ${GITEA_TOKEN_ENV[0]}.`);
    if (res.status === 403) throw new Error("Gitea refused access (403). The token needs read access to repositories and pull requests.");
    if (res.status === 404) throw new Error(`Repository not found (404). ${token ? "Check the token can read it." : `Set ${GITEA_TOKEN_ENV[0]} for private repos.`}`);
    if (!res.ok) throw new Error(`Gitea answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }
}

async function inChunks<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))));
  return out;
}

/**
 * Gitea reports `mergeable: false` while it is still checking a new or updated PR, not only for real conflicts.
 * Look again after a short wait and believe a PR is conflicting only if it still says so.
 */
async function settleMergeable(client: GiteaClient, r: string, pr: GtPull, settleMs: number): Promise<GtPull> {
  if (pr.mergeable !== false) return pr;
  if (settleMs > 0) await new Promise((res) => setTimeout(res, settleMs));
  const again = await client.get<GtPull>(`${r}/pulls/${pr.number}`).catch((e) => rethrowLimit(e, pr));
  return { ...pr, mergeable: again.mergeable };
}

export async function fetchGiteaPrs(client: GiteaClient, repo: string, settleMs = 2000): Promise<PrPage> {
  const r = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  const list = (state: string, limit: number) => client.get<GtPull[]>(`${r}/pulls?state=${state}&sort=recentupdate&limit=${limit}&page=1`);
  const [openPulls, closedPulls] = await Promise.all([list("open", OPEN_LIMIT), list("closed", 20)]);

  const open = await inChunks(openPulls, async (listed) => {
    const pr = await settleMergeable(client, r, listed, settleMs);
    const reviews = await client.get<GtReview[]>(`${r}/pulls/${pr.number}/reviews`).catch((e) => rethrowLimit(e, [] as GtReview[]));
    const withComments = reviews.filter((rv) => (rv.comments_count ?? 0) > 0 && rv.state !== "PENDING");
    const [comments, status] = await Promise.all([
      Promise.all(withComments.map((rv) => client.get<GtReviewComment[]>(`${r}/pulls/${pr.number}/reviews/${rv.id}/comments`).catch((e) => rethrowLimit(e, [] as GtReviewComment[])))),
      pr.head?.sha ? client.get<{ statuses?: GtStatus[] }>(`${r}/commits/${pr.head.sha}/status`).catch((e) => rethrowLimit(e, null)) : Promise.resolve(null),
    ]);
    return giteaToGhPr(pr, { reviews, comments: comments.flat(), statuses: status ? (status.statuses ?? []) : null });
  });

  const merged = closedPulls.filter((p) => p.merged).slice(0, 10).map((p) => giteaToGhPr(p));
  const closed = closedPulls.filter((p) => !p.merged).slice(0, 10).map((p) => p.number);
  return { open, merged, closed, rate: null };
}

/** Per-PR extras are best effort (a failure just leaves them empty), but a rate limit must still pause the sync. */
function rethrowLimit<T>(err: unknown, fallback: T): T {
  if (err instanceof RateLimited) throw err;
  return fallback;
}

export function giteaProvider(info: ProviderInfo, client = new GiteaClient(info.baseUrl ?? "")): Provider {
  const api = `${info.baseUrl}/api/v1/repos/${info.repo}`;
  const auth = `-H "Authorization: token $${GITEA_TOKEN_ENV[0]}"`;
  return {
    info,
    fetchPrs: () => fetchGiteaPrs(client, info.repo),
    readyCheck: "gitea-token",
    mergeCommand: (n) => `curl -fsS -X POST ${auth} -H "Content-Type: application/json" -d '{"Do":"squash","delete_branch_after_merge":true}' ${api}/pulls/${n}/merge`,
    commentsHint: (n) => `\`curl ${auth} ${api}/pulls/${n}/reviews\` (and \`.../reviews/<id>/comments\`)`,
  };
}
