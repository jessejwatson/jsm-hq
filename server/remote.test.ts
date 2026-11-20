import assert from "node:assert/strict";
import { test } from "node:test";
import { isGithubHost, normalizeBaseUrl, parseRemote, repoPath, webBase } from "./remote";

const parsed = (u: string) => {
  const r = parseRemote(u);
  assert.ok(r, `expected ${u} to parse`);
  return r;
};

test("github https and scp-style remotes", () => {
  for (const u of ["https://github.com/acme/app.git", "https://github.com/acme/app", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app.git", "https://user:tok@github.com/acme/app.git/"]) {
    const r = parsed(u);
    assert.equal(r.host, "github.com", u);
    assert.equal(repoPath(r), "acme/app", u);
    assert.ok(isGithubHost(r.host));
  }
});

test("ssh over 443 is github", () => {
  const r = parsed("ssh://git@ssh.github.com:443/acme/app.git");
  assert.ok(isGithubHost(r.host));
  assert.equal(repoPath(r), "acme/app");
});

test("custom https port is kept for the web base", () => {
  const r = parsed("https://git.example.com:3000/team/repo.git");
  assert.equal(r.port, 3000);
  assert.equal(webBase(r), "https://git.example.com:3000");
});

test("a subpath in front of owner/name is the server's subpath", () => {
  const r = parsed("https://example.com/git/team/repo.git");
  assert.equal(r.subpath, "/git");
  assert.equal(repoPath(r), "team/repo");
  assert.equal(webBase(r), "https://example.com/git");
});

test("ssh port is not the web port and ssh has no subpath", () => {
  const r = parsed("ssh://git@git.example.com:2222/team/repo.git");
  assert.equal(r.port, 2222);
  assert.equal(r.protocol, "ssh");
  assert.equal(webBase(r), "https://git.example.com");
});

test("scp-style with a custom user and nested path keeps the last two segments", () => {
  const r = parsed("forgejo@code.example.org:group/sub/repo.git");
  assert.equal(r.host, "code.example.org");
  assert.equal(repoPath(r), "sub/repo");
});

test("http remotes stay http", () => {
  assert.equal(webBase(parsed("http://192.168.1.5:3000/me/proj.git")), "http://192.168.1.5:3000");
});

test("hosts are lower-cased", () => {
  assert.equal(parsed("https://Git.Example.COM/a/b").host, "git.example.com");
});

test("things that are not remotes", () => {
  for (const u of ["", "   ", null, undefined, "/home/me/repo", "C:\\repos\\app", "git://example.com/a/b.git", "https://example.com/only-one", "file:///tmp/x/y"]) {
    assert.equal(parseRemote(u as string), null, String(u));
  }
});

test("normalizeBaseUrl", () => {
  assert.equal(normalizeBaseUrl("git.example.com"), "https://git.example.com");
  assert.equal(normalizeBaseUrl("https://git.example.com/"), "https://git.example.com");
  assert.equal(normalizeBaseUrl("https://git.example.com/api/v1/"), "https://git.example.com");
  assert.equal(normalizeBaseUrl("http://localhost:3000/git"), "http://localhost:3000/git");
  assert.equal(normalizeBaseUrl("ftp://x"), null);
  assert.equal(normalizeBaseUrl("  "), null);
});
