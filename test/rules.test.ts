import { describe, expect, it } from "vitest";
import { IDLE_LIMIT_SECONDS, idleTooLong, repositoryNameProblem, userNameProblem } from "../src/rules";

describe("user names", () => {
  const good = ["a", "yurenju", "a-b", "a1-b2-c3", "0", "x".repeat(39)];
  const bad = ["", "Yuren", "-a", "a-", "a--b", "a_b", "a.b", "a b", "é", "x".repeat(40)];
  for (const name of good) it(`accepts ${JSON.stringify(name)}`, () => expect(userNameProblem(name)).toBeNull());
  for (const name of bad) it(`rejects ${JSON.stringify(name)}`, () => expect(userNameProblem(name)).toBeTruthy());
});

describe("repository names", () => {
  const good = ["notes", "a", "my-repo_1.0", ".hidden", "..x", "x".repeat(100), "git"];
  const bad = ["", ".", "..", "repo.git", "a/b", "a b", "é", "x".repeat(101)];
  for (const name of good) it(`accepts ${JSON.stringify(name)}`, () => expect(repositoryNameProblem(name)).toBeNull());
  for (const name of bad) it(`rejects ${JSON.stringify(name)}`, () => expect(repositoryNameProblem(name)).toBeTruthy());

  it("suggests the lowercase spelling for uppercase names", () => {
    expect(repositoryNameProblem("Notes")).toContain('"notes"');
  });
});

describe("refresh token idle limit", () => {
  const now = 1_800_000_000;
  it("is 90 days", () => expect(IDLE_LIMIT_SECONDS).toBe(90 * 24 * 60 * 60));
  it("allows exactly 90 days", () => expect(idleTooLong(now - IDLE_LIMIT_SECONDS, now)).toBe(false));
  it("rejects one second more", () => expect(idleTooLong(now - IDLE_LIMIT_SECONDS - 1, now)).toBe(true));
});
