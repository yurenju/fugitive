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
  /** `git rev-list --objects` of each commit, by commit id */
  objects: Record<string, string[]>;
  /**
   * A branch that gets deleted: `kept` is a commit, `gone` its child with a bigger version of the same file, and
   * `gonePack` a full pack of both. git stores the smaller, kept version as a delta against the gone one.
   */
  kept: string;
  gone: string;
  gonePack: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    fixtures: Fixtures;
  }
}

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "fugitive-fixtures-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "buffer",
      input: "",
    });
  git("init", "-q", "-b", "main");
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").toString().trim();
  };
  const packObjects = (input: string, thin = false) =>
    execFileSync("git", ["-C", dir, "pack-objects", "--stdout", "--revs", ...(thin ? ["--thin"] : [])], {
      input,
    }).toString("base64");
  const objects = (commit: string) =>
    git("rev-list", "--objects", commit)
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.slice(0, 40));
  return { dir, commit, packObjects, objects };
}

export default function setup(project: TestProject) {
  const main = repository();
  const side = repository();
  try {
    // A file long enough that git stores a one-line change as a delta.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of a file that is long enough to delta`);
    const commits: string[] = [];
    for (let round = 0; round < 3; round++) {
      lines[round * 10] = `changed in round ${round}`;
      commits.push(main.commit({ "big.txt": lines.join("\n"), [`small${round}.txt`]: `small ${round}\n` }, `round ${round}`));
    }

    const kept = side.commit({ "big.txt": lines.join("\n") }, "kept");
    const more = Array.from({ length: 100 }, (_, i) => `line ${400 + i} only on the gone branch`);
    const gone = side.commit({ "big.txt": [...lines, ...more].join("\n"), "gone.txt": "gone\n" }, "gone");

    const fixtures: Fixtures = {
      commits,
      basePack: main.packObjects(`${commits[1]}\n`),
      thinPack: main.packObjects(`${commits[2]}\n^${commits[1]}\n`, true),
      objects: Object.fromEntries([
        ...commits.map((c) => [c, main.objects(c)]),
        [kept, side.objects(kept)],
        [gone, side.objects(gone)],
      ]),
      kept,
      gone,
      gonePack: side.packObjects(`${gone}\n`),
    };
    project.provide("fixtures", fixtures);
  } finally {
    rmSync(main.dir, { recursive: true, force: true });
    rmSync(side.dir, { recursive: true, force: true });
  }
}
