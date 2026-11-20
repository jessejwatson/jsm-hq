import assert from "node:assert/strict";
import { test } from "node:test";
import { probeGitea, resolveProvider } from "./detect";
import { fetchGiteaPrs, GiteaClient, giteaToGhPr, type GtPull } from "./gitea";
import { RateLimited, reviewOf, taskIdOf, toPullRequest } from "./github";

const pull = (over: Partial<GtPull> = {}): GtPull => ({
  number: 7,
  title: "[B1-T01] Add thing",
  html_url: "https://git.example.com/acme/app/pulls/7",
  state: "open",
  merged: false,
  merged_at: null,
  created_at: "2026-01-02T03:04:05Z",
  mergeable: true,
  head: { ref: "dwight/B1-T01", sha: "abc" },
  ...over,
});

test("open PR maps to the GhPr shape and keeps task matching working", () => {
  const gh = giteaToGhPr(pull());
  assert.equal(gh.state, "OPEN");
  assert.equal(gh.mergeable, "MERGEABLE");
  assert.equal(gh.headRefName, "dwight/B1-T01");
  assert.equal(taskIdOf(gh), "B1-T01");
  const pr = toPullRequest(gh, "human", true, "B1-T01", "dwight");
  assert.equal(pr.url, "https://git.example.com/acme/app/pulls/7");
  assert.equal(pr.merged, false);
  assert.equal(pr.conflict, false);
});

test("merged and closed states", () => {
  assert.equal(giteaToGhPr(pull({ state: "closed", merged: true, merged_at: "2026-01-03T00:00:00Z" })).state, "MERGED");
  assert.equal(giteaToGhPr(pull({ state: "closed" })).state, "CLOSED");
  // mergeable only means something while a PR is open
  assert.equal(giteaToGhPr(pull({ state: "closed", mergeable: false })).mergeable, "UNKNOWN");
});

test("mergeable=false is a conflict; WIP titles are drafts", () => {
  const gh = giteaToGhPr(pull({ mergeable: false, title: "WIP: later" }));
  assert.equal(gh.mergeable, "CONFLICTING");
  assert.equal(gh.isDraft, true);
  assert.equal(giteaToGhPr(pull({ title: "[WIP] x" })).isDraft, true);
  assert.equal(giteaToGhPr(pull()).isDraft, false);
});

test("reviews: approvals, change requests, drafts and dismissals", () => {
  const rv = (id: number, login: string, state: string, at: string, extra = {}) => ({ id, user: { login }, state, submitted_at: at, ...extra });
  const approved = giteaToGhPr(pull(), { reviews: [rv(1, "bob", "APPROVED", "2026-01-02T10:00:00Z"), rv(2, "eve", "PENDING", "2026-01-02T11:00:00Z")] });
  assert.equal(approved.reviewDecision, "APPROVED");
  assert.equal(approved.reviews.nodes.length, 1); // the unsubmitted PENDING review is dropped
  assert.equal(reviewOf(approved, "human").review, "passed");

  const changes = giteaToGhPr(pull(), { reviews: [rv(1, "bob", "APPROVED", "2026-01-02T10:00:00Z"), rv(2, "eve", "REQUEST_CHANGES", "2026-01-02T11:00:00Z")] });
  assert.equal(changes.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(reviewOf(changes, "human").review, "changes-requested");

  // the same reviewer approving after requesting changes clears it
  const flipped = giteaToGhPr(pull(), { reviews: [rv(1, "eve", "REQUEST_CHANGES", "2026-01-02T10:00:00Z"), rv(2, "eve", "APPROVED", "2026-01-02T11:00:00Z")] });
  assert.equal(flipped.reviewDecision, "APPROVED");

  const dismissed = giteaToGhPr(pull(), { reviews: [rv(1, "eve", "REQUEST_CHANGES", "2026-01-02T10:00:00Z", { dismissed: true })] });
  assert.equal(dismissed.reviewDecision, null);
  assert.equal(reviewOf(dismissed, "human").review, "pending");
});

test("unresolved review comments count as open threads; resolved and outdated do not", () => {
  const gh = giteaToGhPr(pull(), {
    reviews: [{ id: 1, user: { login: "bot" }, state: "COMMENT", submitted_at: "2026-01-02T10:00:00Z", comments_count: 3 }],
    comments: [
      { user: { login: "bot" }, position: 4, original_position: 4 },
      { user: { login: "bot" }, position: 5, original_position: 5, resolver: { login: "dwight" } },
      { user: { login: "bot" }, position: 0, original_position: 9 },
    ],
  });
  assert.equal(reviewOf(gh, "human").openComments, 1);
});

test("commit statuses feed the bot-review checks", () => {
  const withStatus = (status: string) => giteaToGhPr(pull(), { statuses: [{ context: "coderabbit", status, description: "" }] });
  assert.equal(reviewOf(withStatus("success"), "coderabbit").review, "passed");
  assert.equal(reviewOf(withStatus("pending"), "coderabbit").review, "reviewing");
  assert.equal(reviewOf(withStatus("failure"), "coderabbit").review, "changes-requested");
});

// ---------------------------------------------------------------- client

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeFetch(routes: Record<string, () => Response>, calls: { url: string; auth: string | null }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const path = url.replace("https://git.example.com/api/v1", "");
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    return hit ? hit[1]() : json({ message: "nope" }, 404);
  }) as typeof fetch;
}

test("fetchGiteaPrs: token header, open + merged + closed split, reviews and statuses joined", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const f = fakeFetch(
    {
      "/repos/acme/app/pulls?state=open": () => json([pull()]),
      "/repos/acme/app/pulls?state=closed": () => json([pull({ number: 5, state: "closed", merged: true }), pull({ number: 6, state: "closed" })]),
      "/repos/acme/app/pulls/7/reviews/9/comments": () => json([{ user: { login: "bob" }, position: 2, original_position: 2 }]),
      "/repos/acme/app/pulls/7/reviews": () => json([{ id: 9, user: { login: "bob" }, state: "REQUEST_CHANGES", submitted_at: "2026-01-02T10:00:00Z", comments_count: 1 }]),
      "/repos/acme/app/commits/abc/status": () => json({ statuses: [{ context: "ci", status: "success" }] }),
    },
    calls,
  );
  const page = await fetchGiteaPrs(new GiteaClient("https://git.example.com", () => "s3cret", f), "acme/app", 0);
  assert.equal(page.open.length, 1);
  assert.equal(page.open[0].reviewDecision, "CHANGES_REQUESTED");
  assert.equal(page.open[0].reviewThreads.nodes.length, 1);
  assert.equal(page.open[0].commits.nodes[0].commit.statusCheckRollup?.contexts.nodes.length, 1);
  assert.deepEqual(page.merged.map((p) => p.number), [5]);
  assert.deepEqual(page.closed, [6]);
  assert.equal(page.rate, null);
  assert.ok(calls.every((c) => c.auth === "token s3cret"));
});

test("a transient mergeable=false is not reported as a conflict", async () => {
  let answers = [true];
  const routes = (listedMergeable: boolean) => ({
    "/repos/acme/app/pulls?state=open": () => json([pull({ mergeable: listedMergeable })]),
    "/repos/acme/app/pulls?state=closed": () => json([]),
    "/repos/acme/app/pulls/7/reviews": () => json([]),
    "/repos/acme/app/commits/abc/status": () => json({ statuses: [] }),
    "/repos/acme/app/pulls/7": () => json(pull({ mergeable: answers[0] })),
  });
  const run = async () => (await fetchGiteaPrs(new GiteaClient("https://git.example.com", () => null, fakeFetch(routes(false))), "acme/app", 0)).open[0].mergeable;
  assert.equal(await run(), "MERGEABLE"); // Gitea finished checking: it was fine
  answers = [false];
  assert.equal(await run(), "CONFLICTING"); // still false after the wait: a real conflict
});

test("errors: 401/403/404 are readable, 429 pauses the sync", async () => {
  const get = (status: number, headers = {}) => new GiteaClient("https://git.example.com", () => null, fakeFetch({ "/x": () => json({}, status, headers) })).get("/x");
  await assert.rejects(get(401), /rejected the token/);
  await assert.rejects(get(403), /refused access/);
  await assert.rejects(get(404), /not found/);
  await assert.rejects(get(500), /500/);
  await assert.rejects(get(429, { "retry-after": "30" }), (e) => e instanceof RateLimited && e.resetAt.getTime() - Date.now() > 20_000);
});

test("a rate limit on a per-PR call still pauses the sync", async () => {
  const f = fakeFetch({
    "/repos/acme/app/pulls?state=open": () => json([pull()]),
    "/repos/acme/app/pulls?state=closed": () => json([]),
    "/repos/acme/app/pulls/7/reviews": () => json({}, 429),
  });
  await assert.rejects(fetchGiteaPrs(new GiteaClient("https://git.example.com", () => null, f), "acme/app", 0), RateLimited);
});

test("an unreachable server says so", async () => {
  const f = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
  await assert.rejects(new GiteaClient("https://git.example.com", () => null, f).get("/x"), /Can't reach https:\/\/git.example.com \(ECONNREFUSED\)/);
});

// ---------------------------------------------------------------- detection

const versionFetch = (version: string | null, seen: string[] = []): typeof fetch =>
  (async (input: string | URL | Request) => {
    seen.push(String(input));
    return version === null ? json({}, 404) : json({ version });
  }) as typeof fetch;

test("probeGitea", async () => {
  assert.equal(await probeGitea("https://git.example.com", versionFetch("1.22.0")), "1.22.0");
  assert.equal(await probeGitea("https://git.example.com", versionFetch(null)), null);
  assert.equal(await probeGitea("https://git.example.com", (async () => { throw new Error("down"); }) as typeof fetch), null);
});

test("github.com origin is GitHub and is never probed", async () => {
  const seen: string[] = [];
  const { provider } = await resolveProvider("git@github.com:acme/app.git", {}, versionFetch("1.0", seen));
  assert.equal(provider?.info.kind, "github");
  assert.equal(provider?.info.repo, "acme/app");
  assert.deepEqual(seen, []);
});

test("other hosts are probed: Gitea vs Forgejo", async () => {
  const gitea = await resolveProvider("https://git.example.com/acme/app.git", {}, versionFetch("1.22.0"));
  assert.equal(gitea.provider?.info.name, "Gitea");
  assert.equal(gitea.provider?.info.baseUrl, "https://git.example.com");
  assert.equal(gitea.provider?.info.source, "probe");
  const forgejo = await resolveProvider("https://codeberg.example/acme/app.git", {}, versionFetch("8.0.0+gitea-1.22.0"));
  assert.equal(forgejo.provider?.info.name, "Forgejo");
});

test("ssh origins probe https on the default port and ignore the ssh port", async () => {
  const seen: string[] = [];
  const { provider } = await resolveProvider("ssh://git@git.example.com:2222/acme/app.git", {}, versionFetch("1.22.0", seen));
  assert.equal(provider?.info.baseUrl, "https://git.example.com");
  assert.deepEqual(seen, ["https://git.example.com/api/v1/version"]);
});

test("a host that isn't Gitea gives no provider and a reason", async () => {
  const r = await resolveProvider("https://gitlab.example.com/acme/app.git", {}, versionFetch(null));
  assert.equal(r.provider, null);
  assert.match(r.reason ?? "", /Settings → Project/);
});

test("override: forced gitea with an address, even when the probe fails", async () => {
  const r = await resolveProvider("git@internal:acme/app.git", { provider: "gitea", baseUrl: "git.corp.example/forge/" }, versionFetch(null));
  assert.equal(r.provider?.info.kind, "gitea");
  assert.equal(r.provider?.info.baseUrl, "https://git.corp.example/forge");
  assert.equal(r.provider?.info.source, "override");
});

test("override: forced github on a non-github host name", async () => {
  const r = await resolveProvider("https://ghe.example.com/acme/app.git", { provider: "github" }, versionFetch("1.22.0"));
  assert.equal(r.provider?.info.kind, "github");
});

test("no origin means no provider", async () => {
  const r = await resolveProvider(null, {}, versionFetch("1.22.0"));
  assert.equal(r.provider, null);
});

test("Gitea merge command targets the API with the token variable, not the token", async () => {
  const { provider } = await resolveProvider("https://git.example.com/acme/app.git", {}, versionFetch("1.22.0"));
  const cmd = provider!.mergeCommand(7);
  assert.match(cmd, /git\.example\.com\/api\/v1\/repos\/acme\/app\/pulls\/7\/merge/);
  assert.match(cmd, /\$GITEA_TOKEN/);
});
