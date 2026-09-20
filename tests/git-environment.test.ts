import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { getExpectedWorktreePath } from "../src/git.ts";
import {
  createConfiguredRepo,
  git,
  makeTempDir,
  read,
  runMonke,
  runMonkeAsync,
  spawnMonkeWorker,
  write,
  writeExecutable
} from "./helpers.ts";
import { configureTestGitEnvironment } from "./setup-git.ts";

function simulateDeveloperGitEnvironment(sandbox: string) {
  const userHome = path.join(sandbox, "user-home");
  const xdgConfig = path.join(sandbox, "xdg");
  const hooks = path.join(sandbox, "developer-hooks");
  const ignoreFile = path.join(sandbox, "developer-ignore");
  const globalConfig = path.join(sandbox, "global-config");
  const systemConfig = path.join(sandbox, "system-config");
  const config = `[commit]\n  gpgSign = true\n[core]\n  hooksPath = ${hooks}\n  excludesFile = ${ignoreFile}\n`;
  write(sandbox, "developer-ignore", "*.txt\n");
  writeExecutable(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 73\n");
  writeExecutable(path.join(hooks, "post-checkout"), "#!/bin/sh\nexit 73\n");
  write(userHome, ".gitconfig", config);
  write(userHome, ".config/git/ignore", "*.txt\n");
  write(userHome, ".config/git/attributes", "*.txt developer-attribute\n");
  write(xdgConfig, "git/config", config);
  write(xdgConfig, "git/ignore", "*.txt\n");
  write(xdgConfig, "git/attributes", "*.txt developer-attribute\n");
  write(sandbox, "global-config", config);
  write(sandbox, "system-config", config);
  for (const [key, value] of Object.entries({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_PARAMETERS: "'commit.gpgSign=true'",
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_VALUE_0: "true",
    GIT_DIR: path.join(sandbox, "unrelated.git"),
    HOME: userHome,
    XDG_CONFIG_HOME: xdgConfig
  })) {
    vi.stubEnv(key, value);
  }

  // Apply the same boundary Vitest runs before loading a test file.
  configureTestGitEnvironment();
}

describe("Git test environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("fixtures ignore developer signing, hooks, ignores and injected Git settings", () => {
    const sandbox = makeTempDir("git-environment-fixtures");
    simulateDeveloperGitEnvironment(sandbox);
    const repoRoot = createConfiguredRepo(path.join(sandbox, "repo"), {
      ".gitattributes": "*.txt fixture-attribute\n",
      "fixture.txt": "tracked fixture\n"
    });

    expect(git(repoRoot, ["show", "HEAD:fixture.txt"])).toBe("tracked fixture");
    expect(
      git(repoRoot, ["check-attr", "developer-attribute", "fixture-attribute", "--", "fixture.txt"])
    ).toBe("fixture.txt: developer-attribute: unspecified\nfixture.txt: fixture-attribute: set");
    expect(git(repoRoot, ["config", "user.name"])).toBe("Test User");
    expect(
      git(repoRoot, ["config", "user.name"], {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Explicit Test Author"
      })
    ).toBe("Explicit Test Author");
  });

  test.each(["sync", "async", "worker"] as const)(
    "%s CLI carries files ignored by developer config and preserves repository hooks",
    async (mode) => {
      const sandbox = makeTempDir(`git-environment-${mode}`);
      simulateDeveloperGitEnvironment(sandbox);
      const repoRoot = createConfiguredRepo(path.join(sandbox, "repo"), {
        "fixture.txt": "tracked fixture\n"
      });
      const localHooks = path.join(sandbox, "local-hooks");
      writeExecutable(
        path.join(localHooks, "post-checkout"),
        '#!/bin/sh\nprintf local > "$PWD/local-hook-marker"\n'
      );
      git(repoRoot, ["config", "core.hooksPath", localHooks]);
      write(repoRoot, "dirty.txt", "untracked work\n");
      const options = {
        args: ["spawn", "isolated"],
        cwd: repoRoot,
        monkeHome: path.join(sandbox, "monke-home")
      };

      if (mode === "sync") {
        runMonke(options);
      } else if (mode === "async") {
        await runMonkeAsync(options);
      } else {
        const worker = spawnMonkeWorker(options);
        const exitCode = await worker.exited;
        if (exitCode !== 0) {
          throw new Error(`mt worker exited with ${exitCode}`);
        }
      }

      const worktreeRoot = getExpectedWorktreePath(options.monkeHome, repoRoot, "isolated");
      expect(read(worktreeRoot, "local-hook-marker")).toBe("local");
      expect(read(worktreeRoot, "fixture.txt")).toBe("tracked fixture\n");
      expect(read(worktreeRoot, "dirty.txt")).toBe("untracked work\n");
    }
  );
});
