// 在 Node 裡跑一次：產生測試用的使用者金鑰，並用真的 git 產生 pack 測資，交給 Worker 裡的測試。
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export interface Fixtures {
  /** OpenSSH 格式的公鑰那一行 */
  userKey: string;
  /** PKCS#8（base64），測試裡用 WebCrypto 簽章 */
  userPrivateKey: string;
  strangerPrivateKey: string;
  strangerKey: string;
  commits: string[];
  /** 第 1–2 個 commit 的完整 pack */
  basePack: string;
  /** 第 3 個 commit 的 thin pack，delta 的底稿在 basePack 裡 */
  thinPack: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    fixtures: Fixtures;
  }
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x!;
  const pub = Buffer.from(raw, "base64url");
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    pub,
  ]);
  return {
    line: `ssh-ed25519 ${blob.toString("base64")} test`,
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
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
    // 一個夠長的檔案，改一行之後 git 會用 delta 存。
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

    const user = keyPair();
    const stranger = keyPair();
    const fixtures: Fixtures = {
      userKey: user.line,
      userPrivateKey: user.pkcs8,
      strangerKey: stranger.line,
      strangerPrivateKey: stranger.pkcs8,
      commits,
      basePack: packObjects(`${commits[1]}\n`, false),
      thinPack: packObjects(`${commits[2]}\n^${commits[1]}\n`, true),
    };
    project.provide("fixtures", fixtures);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
