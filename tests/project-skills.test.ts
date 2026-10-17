import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { readImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { getExpectedWorktreePath } from "../src/git.ts";
import { saveGlobalMonkeConfig } from "../src/global-config.ts";
import { runCliAsync } from "../src/index.ts";
import { projectSkillRegistry } from "../src/project-skills.ts";
import {
  createRepo,
  git,
  installFakeCodexSummary,
  installFakeCodiff,
  makeTempDir,
  read,
  write
} from "./helpers.ts";
import { createTestRuntime } from "./runtime-fixture.ts";

function fixture() {
  const sandbox = makeTempDir("project-skills");

  const repo = createRepo(path.join(sandbox, "consumer"), {
    ".claude/CLAUDE.md": "Project instructions.\n",
    ".codex/AGENTS.md": "Project instructions.\n",
    ".gitignore": ".env\n",
    "monke.yml": "apps: {}\n"
  });

  const monkeHome = path.join(sandbox, "monke-home");
  const home = path.join(sandbox, "home");
  const bin = path.join(sandbox, "bin");
  installFakeCodiff(bin);
  installFakeCodexSummary(bin);
  saveGlobalMonkeConfig(monkeHome, {
    diffAdapter: "codiff",
    skillInstallPreference: {
      targets: [
        { kind: "codex" },
        { kind: "claude" },
        { kind: "cursor" },
        { kind: "custom", path: path.join(home, "custom-skills") }
      ]
    },
    version: 1
  });
  const source = path.join(sandbox, "lfv", "skills");
  writeSkill(source, "lfv-view", "First version.\n");
  writeSkill(source, "lfv-share", "Share instructions.\n");
  let stdout = "";

  const env = {
    HOME: home,
    MONKE_HOME: monkeHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`
  };

  const runtimeAt = (cwd: string) =>
    createTestRuntime({
      cwd,
      env,
      onStderr() {},
      onStdout(message) {
        stdout += message;
      }
    });

  const runtime = runtimeAt(repo);
  const registry = projectSkillRegistry(runtime).root;

  const installedAt = (checkout: string, slug: string) => [
    path.join(checkout, ".agents", "skills", "monke-tools", "imported", slug),
    path.join(checkout, ".claude", "skills", slug),
    path.join(checkout, ".cursor", "skills", "monke-tools", "imported", slug)
  ];

  return {
    home,
    installedAt,
    monkeHome,
    registry,
    repo,
    runtime,
    runtimeAt,
    sandbox,
    source,
    stdout: () => stdout
  };
}

function writeSkill(source: string, slug: string, body: string) {
  write(source, `${slug}/SKILL.md`, `---\nname: ${slug}\ndescription: Use LFV.\n---\n${body}`);
}

describe("project skill installation", () => {
  it("description overrides preserve YAML anchors and comments used by other metadata", async () => {
    const f = fixture();
    write(
      f.source,
      "lfv-view/SKILL.md",
      "---\nname: lfv-view\ndescription: &desc Use LFV. # Keep this comment\nmetadata:\n  summary: *desc\n---\nInstructions.\n"
    );
    await runCliAsync(["skills", "add", f.source, "--project", "--name", "lfv"], f.runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        "lfv",
        "lfv-view",
        "--project",
        "--description",
        "Use to view local files."
      ],
      f.runtime
    );
    const markdown = read(f.source, "lfv-view/SKILL.md");
    expect(parse(markdown.split("---")[1] ?? "")).toMatchObject({
      description: "Use to view local files.",
      metadata: { summary: "Use to view local files." }
    });
    expect(markdown).toContain("# Keep this comment");
    expect(markdown.split("---")[2]).toBe("\nInstructions.\n");
  });

  it("project description overrides reach every target and survive source refresh", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.source, "--project", "--name", "lfv"], f.runtime);
    await runCliAsync(
      [
        "skills",
        "policy",
        "lfv",
        "lfv-view",
        "--project",
        "--description",
        "Use to view local files."
      ],
      f.runtime
    );
    writeSkill(f.source, "lfv-view", "Updated instructions.\n");
    await runCliAsync(["skills", "update", "--project"], f.runtime);

    for (const destination of f.installedAt(f.repo, "lfv-view")) {
      expect(read(destination, "SKILL.md")).toContain("description: Use to view local files.");
      expect(read(destination, "SKILL.md")).toContain("Updated instructions.");
      expect(existsSync(path.join(destination, "agents/openai.yaml"))).toBeFalsy();
    }

    expect(readImportRecipeStore(f.registry).recipes[0]?.skills).toContainEqual({
      description: "Use to view local files.",
      kind: "skill",
      selector: "lfv-view",
      slug: "lfv-view"
    });
    expect(existsSync(path.join(f.monkeHome, "skill-registry"))).toBeFalsy();
  });

  it("local sources link by default, including supporting files, without global installation", async () => {
    const f = fixture();
    write(f.source, "lfv-view/references/usage.md", "First reference.\n");
    writeSkill(path.join(f.source, "..", ".agents/skills"), "consumed-skill", "Not published.\n");
    mkdirSync(path.join(f.repo, "nested"));
    await runCliAsync(
      ["skills", "add", path.join(f.source, ".."), "--project", "--skill", "lfv-view"],
      f.runtimeAt(path.join(f.repo, "nested"))
    );
    expect(
      lstatSync(path.join(f.registry, "skills/imported/lfv-view")).isSymbolicLink()
    ).toBeTruthy();

    for (const destination of f.installedAt(f.repo, "lfv-view")) {
      expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-view"));
      expect(read(destination, "references/usage.md")).toBe("First reference.\n");
    }

    writeSkill(f.source, "lfv-view", "Second version.\n");
    write(f.source, "lfv-view/references/usage.md", "Second reference.\n");

    for (const destination of f.installedAt(f.repo, "lfv-view")) {
      expect(read(destination, "SKILL.md")).toContain("Second version.");
      expect(read(destination, "references/usage.md")).toBe("Second reference.\n");
    }

    expect(f.installedAt(f.repo, "lfv-share").some(existsSync)).toBeFalsy();
    expect(existsSync(path.join(f.monkeHome, "skill-registry"))).toBeFalsy();
    expect(existsSync(f.home)).toBeFalsy();
    expect(read(f.repo, ".claude/CLAUDE.md")).toBe("Project instructions.\n");
    expect(read(f.repo, ".codex/AGENTS.md")).toBe("Project instructions.\n");
    expect(git(f.repo, ["status", "--porcelain"])).toBe("");
    await runCliAsync(["skills", "list", "--project"], f.runtime);
    expect(f.stdout()).toContain("lfv\tlink\t1 skills");
  });

  it("collisions preserve project skills and leave the registration unpublished", async () => {
    const f = fixture();
    writeSkill(path.join(f.repo, ".claude/skills"), "lfv-view", "User-owned instructions.\n");
    await expect(runCliAsync(["skills", "add", f.source, "--project"], f.runtime)).rejects.toThrow(
      /Refusing to overwrite/u
    );
    expect(read(f.repo, ".claude/skills/lfv-view/SKILL.md")).toContain("User-owned instructions.");
    expect(readImportRecipeStore(f.registry).recipes).toStrictEqual([]);
    expect(existsSync(path.join(f.repo, ".agents/skills/monke-tools"))).toBeFalsy();
    expect(read(f.source, "lfv-view/SKILL.md")).toContain("First version.");
  });

  it("project targets cannot write through an agent directory linked outside the repo", async () => {
    const f = fixture();
    const external = path.join(f.home, "global-claude");
    mkdirSync(external, { recursive: true });
    symlinkSync(external, path.join(f.repo, ".claude/skills"), "dir");
    await expect(runCliAsync(["skills", "add", f.source, "--project"], f.runtime)).rejects.toThrow(
      /outside this checkout/u
    );
    expect(existsSync(path.join(external, "lfv-view"))).toBeFalsy();
    expect(readImportRecipeStore(f.registry).recipes).toStrictEqual([]);
    expect(existsSync(path.join(f.repo, ".agents/skills/monke-tools"))).toBeFalsy();
  });

  it.each(["directory", "read-only"] as const)(
    "exclusion preflight rejects a %s before publishing links",
    async (kind) => {
      const f = fixture();
      const exclude = path.join(f.repo, ".git/info/exclude");

      if (kind === "directory") {
        rmSync(exclude);
        mkdirSync(exclude);
      } else {
        chmodSync(exclude, 0o444);
      }

      try {
        await expect(
          runCliAsync(["skills", "add", f.source, "--project"], f.runtime)
        ).rejects.toThrow(/Project skill exclusions/u);
        expect(readImportRecipeStore(f.registry).recipes).toStrictEqual([]);
        expect(existsSync(path.join(f.repo, ".agents/skills/monke-tools"))).toBeFalsy();
      } finally {
        if (kind === "read-only") {
          chmodSync(exclude, 0o644);
        }
      }
    }
  );

  it.each([false, true])(
    "a failed exclusion write restores project projections with an internal alias=%s",
    async (alias) => {
      const f = fixture();
      const physical = path.join(f.repo, alias ? "local-skills" : ".claude/skills");
      mkdirSync(physical, { recursive: true });

      if (alias) {
        symlinkSync(physical, path.join(f.repo, ".claude/skills"), "dir");
      }

      const exclude = path.join(f.repo, ".git/info/exclude");
      const original = read(f.repo, ".git/info/exclude");
      f.runtime.writeStderr = (message) => {
        if (message.startsWith("Linked monke-tools skills")) {
          chmodSync(exclude, 0o444);
        }
      };

      try {
        await expect(
          runCliAsync(["skills", "add", f.source, "--project"], f.runtime)
        ).rejects.toThrow(/not writable/u);
        expect(readImportRecipeStore(f.registry).recipes).toStrictEqual([]);

        for (const destination of f.installedAt(f.repo, "lfv-view")) {
          expect(existsSync(destination)).toBeFalsy();
        }

        expect(realpathSync(path.join(f.repo, ".claude/skills"))).toBe(physical);
        expect(existsSync(path.join(physical, "lfv-view"))).toBeFalsy();
        expect(existsSync(path.join(physical, ".monke-tools-flat-skills.json"))).toBeFalsy();
        expect(read(f.repo, ".git/info/exclude")).toBe(original);
        expect(read(f.source, "lfv-view/SKILL.md")).toContain("First version.");
      } finally {
        chmodSync(exclude, 0o644);
      }
    }
  );

  it("removal preserves the source, unrelated project skills, and Git exclusions", async () => {
    const f = fixture();
    write(f.repo, ".git/info/exclude", "# User exclusions\nlocal-notes\n");
    await runCliAsync(["skills", "add", f.source, "--name", "lfv", "--project"], f.runtime);
    writeSkill(path.join(f.repo, ".claude/skills"), "personal", "Personal instructions.\n");
    await runCliAsync(["skills", "remove", "lfv", "--project"], f.runtime);
    expect(f.installedAt(f.repo, "lfv-view").some(existsSync)).toBeFalsy();
    expect(read(f.source, "lfv-view/SKILL.md")).toContain("First version.");
    expect(read(f.repo, ".claude/skills/personal/SKILL.md")).toContain("Personal instructions.");
    expect(read(f.repo, ".git/info/exclude")).toContain("# User exclusions\nlocal-notes\n");
    expect(git(f.repo, ["status", "--porcelain", "--untracked-files=all"])).toContain(
      ".claude/skills/personal/"
    );
    expect(readImportRecipeStore(f.registry).recipes).toStrictEqual([]);
  });

  it("project update rediscovers added and removed folders", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.source, "--name", "lfv", "--project"], f.runtime);
    rmSync(path.join(f.source, "lfv-share"), { recursive: true });
    writeSkill(f.source, "lfv-ops", "New skill.\n");
    await runCliAsync(["skills", "update", "--project"], f.runtime);

    for (const destination of f.installedAt(f.repo, "lfv-ops")) {
      expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-ops"));
    }

    expect(f.installedAt(f.repo, "lfv-share").some(existsSync)).toBeFalsy();
    expect(git(f.repo, ["status", "--porcelain"])).toBe("");
  });

  it("spawn and setup recreate the shared registrations in a Session worktree", async () => {
    const f = fixture();
    await runCliAsync(["skills", "add", f.source, "--name", "lfv", "--project"], f.runtime);
    await runCliAsync(["spawn", "feature/demo"], f.runtime);
    const worktree = getExpectedWorktreePath(f.monkeHome, f.repo, "feature/demo");
    const worktreeRuntime = f.runtimeAt(worktree);
    expect(projectSkillRegistry(worktreeRuntime).root).toBe(f.registry);

    for (const destination of f.installedAt(worktree, "lfv-view")) {
      expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-view"));
    }

    rmSync(path.join(worktree, ".claude/skills/lfv-view"));
    await runCliAsync(["setup"], worktreeRuntime);
    expect(realpathSync(path.join(worktree, ".claude/skills/lfv-view"))).toBe(
      path.join(f.source, "lfv-view")
    );
    writeSkill(f.source, "lfv-view", "Updated source.\n");

    for (const checkout of [f.repo, worktree]) {
      for (const destination of f.installedAt(checkout, "lfv-view")) {
        expect(read(destination, "SKILL.md")).toContain("Updated source.");
      }

      expect(git(checkout, ["status", "--porcelain"])).toBe("");
    }

    await runCliAsync(["skills", "list", "--project"], worktreeRuntime);
    expect(f.stdout()).toContain("lfv\tlink\t2 skills");
  });

  it.each([false, true])(
    "setup restores links without monke.yml in a linked worktree=%s",
    async (linkedWorktree) => {
      const f = fixture();

      const sourceRepo = createRepo(path.join(f.sandbox, "configless"), {
        "README.md": "Skill consumer.\n"
      });

      const checkout = linkedWorktree ? path.join(f.sandbox, "worktree") : sourceRepo;

      if (linkedWorktree) {
        git(sourceRepo, ["worktree", "add", "-b", "feature/skills", checkout]);
      }

      await runCliAsync(["skills", "add", f.source, "--project"], f.runtimeAt(checkout));

      for (const agent of [".agents", ".claude", ".cursor"]) {
        rmSync(path.join(checkout, agent, "skills"), { recursive: true });
      }

      const nested = path.join(checkout, "nested");
      mkdirSync(nested);
      await runCliAsync(["setup"], f.runtimeAt(nested));

      for (const destination of f.installedAt(checkout, "lfv-view")) {
        expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-view"));
      }

      expect(existsSync(path.join(checkout, ".env"))).toBeFalsy();
    }
  );

  it("each consumer repo owns its selection of the same source", async () => {
    const f = fixture();
    const other = createRepo(path.join(f.sandbox, "other"), { "README.md": "Other consumer.\n" });
    await runCliAsync(
      ["skills", "add", f.source, "--name", "lfv", "--project", "--skill", "lfv-view"],
      f.runtime
    );
    await runCliAsync(
      ["skills", "add", f.source, "--name", "lfv", "--project", "--skill", "lfv-share"],
      f.runtimeAt(other)
    );
    await runCliAsync(["skills", "remove", "lfv", "--project"], f.runtime);

    for (const destination of f.installedAt(other, "lfv-share")) {
      expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-share"));
    }

    expect(f.installedAt(other, "lfv-view").some(existsSync)).toBeFalsy();
    expect(git(other, ["status", "--porcelain"])).toBe("");
  });

  it("an unconfigured user can link into a fresh repository before its first commit", async () => {
    const f = fixture();
    rmSync(path.join(f.monkeHome, "config.yml"));
    const fresh = path.join(f.sandbox, "fresh");
    mkdirSync(fresh);
    git(fresh, ["init"]);
    await runCliAsync(["skills", "add", f.source, "--project"], f.runtimeAt(fresh));

    for (const agent of [".agents", ".claude", ".cursor"]) {
      rmSync(path.join(fresh, agent, "skills"), { recursive: true });
    }

    await runCliAsync(["setup"], f.runtimeAt(fresh));

    for (const destination of f.installedAt(fresh, "lfv-view")) {
      expect(realpathSync(destination)).toBe(path.join(f.source, "lfv-view"));
    }

    expect(git(fresh, ["status", "--porcelain"])).toBe("");
  });
});
