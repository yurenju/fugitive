// Runs once in Node: generate pack fixtures with real git, for the tests in the Worker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export interface Fixtures {
  commits: string[];
  /** Full pack of commits 1–2 */
  basePack: string;
  /** Thin pack of commit 3; its delta bases are in basePack */
  thinPack: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    fixtures: Fixtures;
  }
}

export default function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "fugitive-fixtures-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        encoding: "buffer",
        input: "",
      });
    git("init", "-q", "-b", "main");
    // A file long enough that git stores a one-line change as a delta.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of a file that is long enough to delta`);
    const commits: string[] = [];
    for (let round = 0; round < 3; round++) {
      lines[round * 10] = `changed in round ${round}`;
      writeFileSync(join(dir, "big.txt"), lines.join("\n"));
      writeFileSync(join(dir, `small${round}.txt`), `small ${round}\n`);
      git("add", ".");
      git("commit", "-qm", `round ${round}`);
      commits.push(git("rev-parse", "HEAD").toString().trim());
    }
    const packObjects = (input: string, thin: boolean) =>
      execFileSync("git", ["-C", dir, "pack-objects", "--stdout", "--revs", ...(thin ? ["--thin"] : [])], {
        input,
      }).toString("base64");

    const fixtures: Fixtures = {
      commits,
      basePack: packObjects(`${commits[1]}\n`, false),
      thinPack: packObjects(`${commits[2]}\n^${commits[1]}\n`, true),
    };
    project.provide("fixtures", fixtures);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
