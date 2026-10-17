import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { stringify } from "yaml";

import {
  createRepo,
  git,
  installFakeCodiff,
  makeTempDir,
  read,
  write,
  writeExecutable
} from "./helpers.ts";

const reviewScript = path.resolve(import.meta.dirname, "../scripts/review-skills.ts");
const skillPath = "skills/imported/example/SKILL.md";

function historyFixture() {
  const sandbox = makeTempDir("skill-history");

  const repo = createRepo(path.join(sandbox, "consumer"), {
    "monke.yml": "apps: {}\n",
    [skillPath]: "---\nname: example\n---\nBefore recipes.\n",
    "skills/references/imported/guide/MAIN.md": "Committed reference.\n"
  });

  const bin = path.join(sandbox, "bin");
  const reviewLog = installFakeCodiff(bin);
  const monkeHome = path.join(sandbox, "monke-home");

  const run = async (base: string, head = "HEAD") => {
    const child = Bun.spawn([process.execPath, reviewScript, base, head, "--adapter", "codiff"], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: path.join(sandbox, "home"),
        MONKE_HOME: monkeHome,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`
      },
      stderr: "pipe",
      stdout: "pipe"
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);

    return { exitCode, stderr, stdout };
  };

  const openedComparison = () => {
    const [flag, commit, repository] = read(bin, path.basename(reviewLog)).trim().split("\n");

    if (flag !== "--commit" || !commit || !repository) {
      throw new Error("Expected one complete comparison delivered to Codiff");
    }

    return { commit, repository };
  };

  return { bin, monkeHome, openedComparison, repo, run, sandbox };
}

describe("historical skill review CLI", () => {
  it("preserves committed guidance before recipes and before pinned locks", async () => {
    const fixture = historyFixture();
    const base = git(fixture.repo, ["rev-parse", "HEAD"]);
    write(fixture.repo, skillPath, "---\nname: example\n---\nBefore pinned locks.\n");
    write(
      fixture.repo,
      "skills/imported/.monke-imports.json",
      JSON.stringify({
        recipes: [
          {
            skills: [{ kind: "skill", selector: "example", slug: "example" }],
            source: "https://example.invalid/unavailable.git"
          }
        ],
        version: 3
      })
    );
    git(fixture.repo, ["add", "."]);
    git(fixture.repo, ["commit", "-m", "Record pre-lock recipe"]);
    writeExecutable(path.join(fixture.bin, "npx"), "#!/bin/sh\nexit 99\n");

    const result = await fixture.run(base);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const { commit, repository } = fixture.openedComparison();
    expect(git(repository, ["show", `${commit}^:${skillPath}`])).toContain("Before recipes.");
    expect(git(repository, ["show", `${commit}:${skillPath}`])).toContain("Before pinned locks.");
    expect(git(repository, ["show", `${commit}^:skills/references/imported/guide/MAIN.md`])).toBe(
      "Committed reference."
    );
    expect(git(repository, ["show", `${commit}:skills/references/imported/guide/MAIN.md`])).toBe(
      "Committed reference."
    );
  });

  it("rebuilds old v3 locks and repo recipes from accepted pins with current tooling", async () => {
    const fixture = historyFixture();

    const upstream = createRepo(path.join(fixture.sandbox, "upstream"), {
      "skills/example/SKILL.md":
        "---\nname: example\ndescription: Original trigger.\n---\nAccepted upstream bytes.\n"
    });

    const accepted = git(upstream, ["rev-parse", "HEAD"]);
    write(upstream, "skills/example/SKILL.md", "---\nname: example\n---\nUnaccepted HEAD.\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "Advance upstream"]);
    git(fixture.repo, ["rm", "-r", "skills"]);
    write(
      fixture.repo,
      "skills.lock.json",
      JSON.stringify({
        recipes: [
          {
            disableModelInvocation: true,
            lock: {
              commit: accepted,
              digest: "0".repeat(64),
              importerVersion: "0.0.1",
              materializerVersion: 999,
              repository: upstream,
              subpath: "",
              updateRef: "HEAD"
            },
            skills: [{ kind: "skill", selector: "example", slug: "example" }],
            source: upstream
          }
        ],
        version: 3
      })
    );
    git(fixture.repo, ["add", "."]);
    git(fixture.repo, ["commit", "-m", "Use legacy pinned lock"]);
    const base = git(fixture.repo, ["rev-parse", "HEAD"]);
    git(fixture.repo, ["rm", "skills.lock.json"]);
    write(
      fixture.repo,
      "monke.yml",
      stringify({
        skills: [
          {
            commit: accepted,
            modelInvocation: "allow",
            skills: [{ description: "Consumer trigger.", slug: "example" }],
            source: upstream
          }
        ]
      })
    );
    git(fixture.repo, ["add", "."]);
    git(fixture.repo, ["commit", "-m", "Move pin into repo declaration"]);
    writeExecutable(
      path.join(fixture.bin, "npx"),
      `#!/bin/sh
set -eu
[ "$2" = skills@1.7.0 ]
mkdir -p .agents/skills
cp -R "$4/skills/"* .agents/skills/
`
    );

    const result = await fixture.run(base);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const { commit, repository } = fixture.openedComparison();
    const before = git(repository, ["show", `${commit}^:${skillPath}`]);
    const after = git(repository, ["show", `${commit}:${skillPath}`]);
    expect(before).toContain("Accepted upstream bytes.");
    expect(after).toContain("Accepted upstream bytes.");
    expect(before).toContain("disable-model-invocation: true");
    expect(after).toContain("disable-model-invocation: false");
    expect(after).toContain("description: Consumer trigger.");
  });

  it("removes historical guidance for an explicit empty repo declaration", async () => {
    const fixture = historyFixture();
    const base = git(fixture.repo, ["rev-parse", "HEAD"]);
    write(fixture.repo, "monke.yml", "skills: []\n");
    git(fixture.repo, ["add", "monke.yml"]);
    git(fixture.repo, ["commit", "-m", "Remove imported guidance"]);

    const result = await fixture.run(base);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const { commit, repository } = fixture.openedComparison();
    expect(git(repository, ["diff", "--name-status", `${commit}^`, commit])).toContain(
      `D\t${skillPath}`
    );
  });

  it("refuses modern unpinned declarations even when imported bytes are committed", async () => {
    const fixture = historyFixture();
    write(
      fixture.repo,
      "monke.yml",
      stringify({ skills: [{ skills: ["example"], source: "owner/unpinned" }] })
    );
    git(fixture.repo, ["add", "monke.yml"]);
    git(fixture.repo, ["commit", "-m", "Add unpinned declaration"]);

    const result = await fixture.run("HEAD");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mt skills update --repo");
    expect(
      existsSync(path.join(fixture.monkeHome, "skill-reviews", "comparisons.json"))
    ).toBeFalsy();
  });
});
