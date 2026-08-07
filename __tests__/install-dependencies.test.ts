import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { makeTempDir, runMonke } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("dependency installation", () => {
  test("Brewfile declares the narrowly trusted Codiff cask", () => {
    expect(readFileSync(path.join(projectRoot, "Brewfile"), "utf-8")).toBe(
      'cask_args require_sha: true\ncask "nkzw-tech/tap/codiff", greedy: true, trusted: true\n'
    );
  });

  test("install-dependencies remains a compatibility no-op", () => {
    const sandbox = makeTempDir("install-dependencies-noop");
    const binDirectory = path.join(sandbox, "bin");
    mkdirSync(binDirectory, { recursive: true });
    const home = path.join(sandbox, "home");

    const result = runMonke({
      args: ["install-dependencies"],
      binDirectory,
      cwd: sandbox,
      extraEnv: { PATH: binDirectory },
      monkeHome: home
    });

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Verified monke-tools runtime dependencies\n");
  });

  test("install-local installs or upgrades Brewfile dependencies", () => {
    const sandbox = makeTempDir("install-local-homebrew-dependencies");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const brewLog = path.join(sandbox, "brew.log");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");

    prepareInstallFixture(checkout, binDirectory);
    installFakePlatform(binDirectory, "Darwin", "arm64");
    installFakeBrew(binDirectory);

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BREW_CHECK_EXIT: "1",
        BREW_INSTALL_EXIT: "0",
        BREW_LOG: brewLog,
        BUN_LOG: bunLog,
        HOME: home,
        INSTALL_DEPENDENCIES_EXIT: "0",
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(0);
    expect(readFileSync(brewLog, "utf-8")).toBe(
      `bundle check --file=${path.join(checkout, "Brewfile")}\n` +
        `bundle install --file=${path.join(checkout, "Brewfile")}\n`
    );
    expect(result.stdout).toContain("Installing Homebrew dependencies...");
  });

  test("install-local stops before building when Homebrew dependency installation fails", () => {
    const sandbox = makeTempDir("install-local-homebrew-failure");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const brewLog = path.join(sandbox, "brew.log");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");

    prepareInstallFixture(checkout, binDirectory);
    installFakePlatform(binDirectory, "Darwin", "arm64");
    installFakeBrew(binDirectory);

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BREW_CHECK_EXIT: "1",
        BREW_INSTALL_EXIT: "23",
        BREW_LOG: brewLog,
        BUN_LOG: bunLog,
        HOME: home,
        INSTALL_DEPENDENCIES_EXIT: "0",
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(23);
    expect(existsSync(bunLog)).toBeFalsy();
    expect(existsSync(monkeToolsLog)).toBeFalsy();
  });

  test("install-local runs dependency installation before skill installation and stops on dependency failure", () => {
    const sandbox = makeTempDir("install-local-dependencies");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");

    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(
      path.join(checkout, "scripts", "install-local.sh"),
      readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8"),
      "utf-8"
    );
    chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
    writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf-8");
    installFakeBun(binDirectory);

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_LOG: bunLog,
        HOME: home,
        INSTALL_DEPENDENCIES_EXIT: "17",
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(17);
    expect(readFileSync(bunLog, "utf-8")).toContain(`pwd:${path.join(checkout, "builds")}\n`);
    expect(readFileSync(monkeToolsLog, "utf-8")).toBe("install-dependencies\n");
  });

  test("install-local continues to skill installation after dependency installation succeeds", () => {
    const sandbox = makeTempDir("install-local-dependencies-success");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");

    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(
      path.join(checkout, "scripts", "install-local.sh"),
      readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8"),
      "utf-8"
    );
    chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
    writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf-8");
    installFakeBun(binDirectory);
    const obsoleteCommand = path.join(home, ".local", "bin", "monke-tools");
    mkdirSync(path.dirname(obsoleteCommand), { recursive: true });
    writeFileSync(obsoleteCommand, "obsolete", "utf-8");
    const obsoleteBuilds = [
      path.join(checkout, "dist", "monke-tools"),
      path.join(checkout, "dist", "monke")
    ];
    for (const obsoleteBuild of obsoleteBuilds) {
      mkdirSync(path.dirname(obsoleteBuild), { recursive: true });
      writeFileSync(obsoleteBuild, "obsolete", "utf-8");
    }

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_LOG: bunLog,
        HOME: home,
        INSTALL_DEPENDENCIES_EXIT: "0",
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(0);
    expect(readFileSync(bunLog, "utf-8")).toContain(`pwd:${path.join(checkout, "builds")}\n`);
    expect(readFileSync(monkeToolsLog, "utf-8")).toBe(
      `install-dependencies\nshell install\nskills local-install ${checkout}\n`
    );
    const installedMt = readFileSync(path.join(home, ".local", "bin", "mt"), "utf-8");
    expect(installedMt).toContain("MONKE_TOOLS_LOG");
    expect(installedMt).not.toContain('exec "$(dirname "$0")/');
    expect(readFileSync(path.join(home, ".local", "bin", "monke"), "utf-8")).toBe(
      '#!/bin/sh\nexec "$(dirname "$0")/mt" "$@"\n'
    );
    expect(existsSync(obsoleteCommand)).toBeFalsy();
    for (const obsoleteBuild of obsoleteBuilds) {
      expect(existsSync(obsoleteBuild)).toBeFalsy();
    }
    expect(result.stdout).toContain("Installed mt and monke");
    expect(result.stdout).toContain(path.join(home, ".local", "bin", "mt"));
    expect(result.stdout).toContain(path.join(home, ".local", "bin", "monke"));
  });

  test("install-local prunes old bun build artifacts after a successful build", () => {
    const sandbox = makeTempDir("install-local-build-retention");
    const checkout = path.join(sandbox, "checkout");
    const buildDirectory = path.join(checkout, "builds");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");

    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    mkdirSync(buildDirectory, { recursive: true });
    writeFileSync(
      path.join(checkout, "scripts", "install-local.sh"),
      readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8"),
      "utf-8"
    );
    chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
    writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf-8");
    writeFileSync(path.join(buildDirectory, ".oldest.bun-build"), "oldest", "utf-8");
    writeFileSync(path.join(buildDirectory, ".older.bun-build"), "older", "utf-8");
    writeFileSync(path.join(buildDirectory, ".newer.bun-build"), "newer", "utf-8");
    writeFileSync(path.join(buildDirectory, ".newest.bun-build"), "newest", "utf-8");
    writeFileSync(path.join(buildDirectory, "manual.txt"), "keep me", "utf-8");
    utimesSync(path.join(buildDirectory, ".oldest.bun-build"), new Date(0), new Date(0));
    utimesSync(path.join(buildDirectory, ".older.bun-build"), new Date(1000), new Date(1000));
    utimesSync(path.join(buildDirectory, ".newer.bun-build"), new Date(2000), new Date(2000));
    utimesSync(path.join(buildDirectory, ".newest.bun-build"), new Date(3000), new Date(3000));
    installFakeBun(binDirectory);

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_LOG: bunLog,
        HOME: home,
        INSTALL_DEPENDENCIES_EXIT: "0",
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(0);
    expect(listBuildArtifacts(buildDirectory)).toStrictEqual([
      ".newer.bun-build",
      ".newest.bun-build"
    ]);
    expect(readFileSync(path.join(buildDirectory, "manual.txt"), "utf-8")).toBe("keep me");
  });
});

function listBuildArtifacts(buildDirectory: string): string[] {
  return readdirSync(buildDirectory)
    .filter((entry) => entry.startsWith(".") && entry.endsWith(".bun-build"))
    .toSorted();
}

function prepareInstallFixture(checkout: string, binDirectory: string): void {
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(path.join(checkout, "src"), { recursive: true });
  writeFileSync(
    path.join(checkout, "scripts", "install-local.sh"),
    readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8"),
    "utf-8"
  );
  chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
  writeFileSync(
    path.join(checkout, "Brewfile"),
    readFileSync(path.join(projectRoot, "Brewfile"), "utf-8"),
    "utf-8"
  );
  writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf-8");
  installFakeBun(binDirectory);
}

function installFakePlatform(binDirectory: string, system: string, architecture: string): void {
  const unamePath = path.join(binDirectory, "uname");
  writeFileSync(
    unamePath,
    `#!/bin/sh\nif [ "\${1:-}" = "-s" ]; then printf '%s\\n' '${system}'; else printf '%s\\n' '${architecture}'; fi\n`,
    "utf-8"
  );
  chmodSync(unamePath, 0o755);
}

function installFakeBrew(binDirectory: string): void {
  const brewPath = path.join(binDirectory, "brew");
  writeFileSync(
    brewPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$BREW_LOG"
if [ "\${1:-}" = "bundle" ] && [ "\${2:-}" = "check" ]; then
  exit "$BREW_CHECK_EXIT"
fi
if [ "\${1:-}" = "bundle" ] && [ "\${2:-}" = "install" ]; then
  exit "$BREW_INSTALL_EXIT"
fi
exit 2
`,
    "utf-8"
  );
  chmodSync(brewPath, 0o755);
}

function installFakeBun(binDirectory: string): void {
  mkdirSync(binDirectory, { recursive: true });
  const bunPath = path.join(binDirectory, "bun");
  writeFileSync(
    bunPath,
    `#!/bin/sh
set -eu
printf 'pwd:%s\\n' "$PWD" >> "$BUN_LOG"
printf '%s\\n' "$*" >> "$BUN_LOG"
outfile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outfile" ]; then
    shift
    outfile="$1"
    break
  fi
  shift
done
if [ -z "$outfile" ]; then
  echo "missing --outfile" >&2
  exit 1
fi
mkdir -p "$(dirname "$outfile")"
cat > "$outfile" <<'EOF'
#!/bin/sh
set -e
printf '%s\n' "$*" >> "$MONKE_TOOLS_LOG"
if [ "$#" -gt 0 ] && [ "$1" = "install-dependencies" ]; then
  exit "$INSTALL_DEPENDENCIES_EXIT"
fi
exit 0
EOF
chmod +x "$outfile"
`,
    "utf-8"
  );
  chmodSync(bunPath, 0o755);
}
