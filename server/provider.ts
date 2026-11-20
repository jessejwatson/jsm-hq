// What HQ needs from a git host: list the PRs (with review state) and say how
// agents merge one. GitHub (gh) and Gitea/Forgejo (REST) implement it.

import type { ProviderInfo } from "../src/data/types";
import type { GhPr, RateLimit } from "./github";

export interface PrPage {
  open: GhPr[];
  merged: GhPr[];
  /** Numbers of recently closed, unmerged PRs. */
  closed: number[];
  /** GitHub's GraphQL budget; null when the host has none HQ can read. */
  rate: RateLimit | null;
}

export interface Provider {
  info: ProviderInfo;
  fetchPrs(): Promise<PrPage>;
  /** Setup check that must pass before HQ polls. */
  readyCheck: "gh" | "gitea-token";
  /** Command the lead runs to merge PR `n`. */
  mergeCommand(n: number | string): string;
  /** How an author reads a PR's review comments. */
  commentsHint(n: number | string): string;
}
