import { existsSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { loadSessionState } from "../src/session-state-store.ts";
import {
  createRepo,
  git,
  makeTempDir,
  read,
  runMonke,
  runMonkeCapturingFailure,
  write
} from "./helpers.ts";

const SESSION = "feature/adopted";

function createAdoptionFixture(prefix: string) {
  const sandbox = makeTempDir(prefix);
  const home = path.join(sandbox, "home");

  const depRoot = createRepo(path.join(sandbox, "dep"), {
    "db/.env": "PORT=5432\n",
    "monke.yml": `apps:
  db:
    path: db
    envFile: .env
    mappings:
      - port: DEP_PORT
        env: PORT
`
  });

  const root = createRepo(path.join(sandbox, "root"), {
    "api/.env": "PORT=3000\nDATABASE_PORT=5432\n",
    "monke.yml": `bootstrapCommand: touch .bootstrapped
apps:
  api:
    path: api
    envFile: .env
    mappings:
      - port: API_PORT
        env: PORT
external:
  dep:
    path: ../dep
    pathEnv: DEP_DIR
    mappings:
      - port: DEP_PORT
        app: api
        env: DATABASE_PORT
`
  });

  // Another tool's worktree: outside Monke home, with a directory name unrelated to its branch.
  const foreignPath = path.join(sandbox, "other-tool", "t3-1234");
  git(root, ["worktree", "add", "-b", SESSION, foreignPath]);
  write(foreignPath, "notes.txt", "uncommitted work\n");

  return { depRoot, foreignPath: realpathSync.native(foreignPath), home, root };
}

describe("adopting an Ordinary worktree", () => {
  it("materializes the worktree in place and records it as the Session's Root repo worktree", () => {
    const { depRoot, foreignPath, home, root } = createAdoptionFixture("adopt-in-place");

    const unadopted = runMonkeCapturingFailure({
      args: ["materialize"],
      cwd: foreignPath,
      monkeHome: home
    });

    expect(unadopted.error?.message).toContain("mt materialize --adopt");

    const adopted = runMonke({
      args: ["materialize", "--adopt"],
      cwd: foreignPath,
      monkeHome: home
    });

    expect(adopted.stderr).toContain("mt chop and default mt cleanup now remove this worktree");

    const state = loadSessionState(home, root, SESSION);
    const depWorktree = path.join(home, "worktrees", "dep", SESSION);

    expect(state.repos.map((repo) => [repo.sourceRoot, repo.worktreePath])).toStrictEqual([
      [depRoot, depWorktree],
      [root, foreignPath]
    ]);
    expect(state.repos.every((repo) => repo.materializationStatus === "materialized")).toBeTruthy();
    expect(existsSync(path.join(foreignPath, ".bootstrapped"))).toBeTruthy();
    expect(read(foreignPath, "notes.txt")).toBe("uncommitted work\n");
    expect(read(foreignPath, "api/.env")).not.toBe("PORT=3000\nDATABASE_PORT=5432\n");
    expect(read(foreignPath, ".env")).toContain(
      `DEP_DIR=${path.relative(foreignPath, depWorktree)}\n`
    );
    expect(existsSync(path.join(home, "worktrees", "root", SESSION))).toBeFalsy();

    // Later runs find the Session from its recorded worktree.
    runMonke({ args: ["materialize"], cwd: foreignPath, monkeHome: home });
    runMonke({ args: ["resources", "acquire"], cwd: foreignPath, monkeHome: home });
  });

  it("chops an adopted Session from inside its worktree and keeps the branches", () => {
    const { foreignPath, home, root } = createAdoptionFixture("adopt-chop");
    const depWorktree = path.join(home, "worktrees", "dep", SESSION);
    runMonke({ args: ["materialize", "--adopt"], cwd: foreignPath, monkeHome: home });
    expect(existsSync(depWorktree)).toBeTruthy();

    runMonke({ args: ["chop", "--force"], cwd: foreignPath, monkeHome: home });

    expect(existsSync(foreignPath)).toBeFalsy();
    expect(existsSync(depWorktree)).toBeFalsy();
    expect(() => loadSessionState(home, root, SESSION)).toThrow("Missing retained Session state");
    expect(git(root, ["branch", "--list", SESSION]).trim()).not.toBe("");
  });

  it("refuses to replace a missing adopted worktree", () => {
    const { foreignPath, home, root } = createAdoptionFixture("adopt-missing");
    runMonke({ args: ["materialize", "--adopt"], cwd: foreignPath, monkeHome: home });
    rmSync(foreignPath, { force: true, recursive: true });

    for (const args of [
      ["spawn", SESSION],
      ["swing", SESSION]
    ]) {
      const result = runMonkeCapturingFailure({ args, cwd: root, monkeHome: home });

      expect(result.error?.message).toContain(`Adopted Session worktree ${foreignPath} is missing`);
    }

    expect(existsSync(path.join(home, "worktrees", "root", SESSION))).toBeFalsy();
  });

  it("rejects a worktree whose removal would reach its Source checkout", () => {
    const { home, root } = createAdoptionFixture("adopt-nested");
    const nestedPath = path.join(root, ".worktrees", "nested");
    git(root, ["worktree", "add", "-b", "feature/nested", nestedPath]);

    const nested = runMonkeCapturingFailure({
      args: ["materialize", "--adopt"],
      cwd: nestedPath,
      monkeHome: home
    });

    expect(nested.error?.message).toContain("not a valid Session worktree");
    expect(existsSync(path.join(home, "sessions"))).toBeFalsy();
  });

  it("rejects a worktree that contains Monke home through a symlinked path", () => {
    const { foreignPath, root } = createAdoptionFixture("adopt-home-alias");
    const alias = path.join(path.dirname(root), "alias");
    symlinkSync(foreignPath, alias);

    const result = runMonkeCapturingFailure({
      args: ["materialize", "--adopt"],
      cwd: foreignPath,
      monkeHome: path.join(alias, ".monke")
    });

    expect(result.error?.message).toContain("not a valid Session worktree");
  });

  it("rejects a worktree nested inside another Session's worktree", () => {
    const { foreignPath, home, root } = createAdoptionFixture("adopt-overlap");
    runMonke({ args: ["materialize", "--adopt"], cwd: foreignPath, monkeHome: home });
    const innerPath = path.join(foreignPath, "inner");
    git(root, ["worktree", "add", "-b", "feature/inner", innerPath]);

    const inner = runMonkeCapturingFailure({
      args: ["materialize", "--adopt"],
      cwd: innerPath,
      monkeHome: home
    });

    expect(inner.error?.message).toContain(`overlaps worktree ${foreignPath}`);
  });

  it("rejects a detached worktree and a Session already bound to another worktree", () => {
    const { foreignPath, home, root } = createAdoptionFixture("adopt-rejections");
    const detachedPath = path.join(path.dirname(foreignPath), "detached");
    git(root, ["worktree", "add", "--detach", detachedPath]);

    const detached = runMonkeCapturingFailure({
      args: ["materialize", "--adopt"],
      cwd: detachedPath,
      monkeHome: home
    });

    expect(detached.error?.message).toContain("check out a branch");

    runMonke({ args: ["materialize", "--adopt"], cwd: foreignPath, monkeHome: home });
    git(foreignPath, ["switch", "-c", "feature/elsewhere"]);
    git(detachedPath, ["switch", SESSION]);

    const rebound = runMonkeCapturingFailure({
      args: ["materialize", "--adopt"],
      cwd: detachedPath,
      monkeHome: home
    });

    expect(rebound.error?.message).toContain(
      `Session ${SESSION} is already bound to ${foreignPath}`
    );
  });
});
