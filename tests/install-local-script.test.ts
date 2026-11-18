import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { object, string } from "zod";

import { createFiles, createRepo, git, makeTempDir, writeExecutable } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_ID_ARGUMENT_PATTERN = /--install-id (?<identity>\S+)/u;
const installScript = readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8");

function prepareInstallFixture(checkout: string, binDirectory: string, dirty: boolean) {
  createFiles(checkout, { "scripts/install-local.sh": installScript, "src/index.ts": "" });
  writeExecutable(
    path.join(binDirectory, "git"),
    `#!/bin/sh
set -eu
case "$*" in
  *"rev-parse HEAD") printf '%s\n' 0123456789abcdef0123456789abcdef01234567 ;;
  *"rev-parse --short=7 HEAD") printf '%s\n' 0123456 ;;
  *"status --porcelain --untracked-files=normal") ${dirty ? "printf '%s\\n' ' M src/index.ts'" : ":"} ;;
  *"diff "*|*"ls-files "*) : ;;
  *) exit 2 ;;
esac
`
  );
  prepareInstallCompiler(binDirectory);
}

function prepareInstallCompiler(binDirectory: string, changedFile?: string) {
  writeExecutable(
    path.join(binDirectory, "bun"),
    `#!/bin/sh
set -eu
[ -f "$MONKE_HOME/locks/installation.lock" ]
printf '%s\n' "$*" >> "$BUN_LOG"
outfile=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outfile" ]; then
    shift
    outfile="$1"
    break
  fi
  shift
done
[ -n "$outfile" ]
/bin/mkdir -p "$(/usr/bin/dirname "$outfile")"
/bin/cat > "$outfile" <<'EOF'
#!/bin/sh
set -eu
[ -f "$MONKE_HOME/locks/installation.lock" ]
printf '%s\n' "$*" >> "$MONKE_TOOLS_LOG"
EOF
/bin/chmod +x "$outfile"
${changedFile === undefined ? "" : `printf 'after\\n' > ${JSON.stringify(changedFile)}`}
`
  );
}

describe("Local install refresh script", () => {
  it("recovers an installation lock left by a dead process", () => {
    const sandbox = makeTempDir("install-local-dead-lock");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const monkeHome = path.join(sandbox, "monke-home");
    const lockPath = path.join(monkeHome, "locks", "installation.lock");
    prepareInstallFixture(checkout, binDirectory, false);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '{"acquiredAt":0,"pid":999999999}\n', "utf-8");

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_LOG: path.join(sandbox, "bun.log"),
        HOME: path.join(sandbox, "home"),
        MONKE_HOME: monkeHome,
        MONKE_TOOLS_LOG: path.join(sandbox, "monke-tools.log"),
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBeFalsy();
    expect(existsSync(`${lockPath}.reclaim`)).toBeFalsy();
  });

  it("builds a unique versioned Local install and delegates activation with provenance", () => {
    const sandbox = makeTempDir("install-local-script");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");
    prepareInstallFixture(checkout, binDirectory, true);

    const result = spawnSync(
      "sh",
      [path.join(checkout, "scripts", "install-local.sh"), "--targets", "codex"],
      {
        cwd: checkout,
        encoding: "utf-8",
        env: {
          ...process.env,
          BUN_LOG: bunLog,
          HOME: home,
          MONKE_HOME: monkeHome,
          MONKE_TOOLS_LOG: monkeToolsLog,
          PATH: `${binDirectory}:/usr/bin:/bin`
        }
      }
    );

    expect(result.status).toBe(0);
    const build = readFileSync(bunLog, "utf-8");
    expect(build).toContain(
      '--define process.env.MONKE_TOOLS_BUILD_IDENTITY="local+0123456-dirty"'
    );
    const activation = readFileSync(monkeToolsLog, "utf-8").trim();
    const [command, stagedInstall, sourceCheckout] = activation.split(" ");
    expect(command).toBe("activate-local-install");

    if (stagedInstall === undefined) {
      throw new Error("activation did not include a staged install path");
    }

    expect(path.dirname(stagedInstall)).toBe(path.join(monkeHome, "install-staging"));
    expect(path.basename(stagedInstall)).toMatch(/^local-0123456-/u);
    expect(sourceCheckout).toBe(checkout);
    expect(activation).toContain(`--install-id ${path.basename(stagedInstall)}`);
    expect(activation).toContain("--source-commit 0123456789abcdef0123456789abcdef01234567");
    expect(activation).toContain("--dirty --installation-lock-held --targets codex");
    expect(existsSync(path.join(monkeHome, "locks", "installation.lock"))).toBeFalsy();
  });

  it("gives two builds from the same commit distinct install identities", () => {
    const sandbox = makeTempDir("install-local-unique");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const bunLog = path.join(sandbox, "bun.log");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");
    prepareInstallFixture(checkout, binDirectory, false);

    const environment = {
      ...process.env,
      BUN_LOG: bunLog,
      HOME: home,
      MONKE_HOME: monkeHome,
      MONKE_TOOLS_LOG: monkeToolsLog,
      PATH: `${binDirectory}:/usr/bin:/bin`
    };

    for (const _attempt of [1, 2]) {
      const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
        cwd: checkout,
        encoding: "utf-8",
        env: environment
      });

      expect(result.status).toBe(0);
    }

    const installIdentities = readFileSync(monkeToolsLog, "utf-8")
      .trim()
      .split("\n")
      .map((line) => INSTALL_ID_ARGUMENT_PATTERN.exec(line)?.groups?.identity);

    expect(new Set(installIdentities).size).toBe(2);
  });

  it.each([
    { label: "tracked source", name: "src/index.ts" },
    ...["café.txt", "-notes.txt", "-"].map((name) => ({ label: `untracked ${name}`, name }))
  ])("aborts before activation when $label changes during compilation", ({ name }) => {
    const sandbox = makeTempDir("install-local-source-change");

    const checkout = createRepo(path.join(sandbox, "checkout"), {
      "scripts/install-local.sh": installScript,
      "src/index.ts": ""
    });

    const binDirectory = path.join(sandbox, "bin");
    const monkeHome = path.join(sandbox, "monke-home");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");
    const changedFile = path.join(checkout, name);
    git(checkout, ["config", "core.quotePath", "true"]);
    writeFileSync(changedFile, "before\n", "utf-8");
    prepareInstallCompiler(binDirectory, changedFile);

    const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
      cwd: checkout,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_LOG: path.join(sandbox, "bun.log"),
        HOME: path.join(sandbox, "home"),
        MONKE_HOME: monkeHome,
        MONKE_TOOLS_LOG: monkeToolsLog,
        PATH: `${binDirectory}:/usr/bin:/bin`
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Source checkout changed while");
    expect(existsSync(monkeToolsLog)).toBeFalsy();
    expect(existsSync(path.join(monkeHome, "current"))).toBeFalsy();
  });

  it("activates the compiled executable through the stable symlink in the real Local refresh", () => {
    const sandbox = makeTempDir("install-local-end-to-end");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const binDirectory = path.join(sandbox, "bin");
    writeExecutable(
      path.join(binDirectory, "codiff"),
      "#!/bin/sh\nprintf '%s\\n' 'codiff v1.14.0'\n"
    );

    const sourceDirty =
      spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: projectRoot,
        encoding: "utf-8"
      }).stdout !== "";

    const install = spawnSync(
      "sh",
      [path.join(projectRoot, "scripts", "install-local.sh"), "--targets", "codex"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(home, ".codex"),
          HOME: home,
          MONKE_HOME: monkeHome,
          PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          SHELL: "/bin/zsh"
        }
      }
    );

    expect(install.status).toBe(0);

    const stableCommand = path.join(home, ".local", "bin", "mt");
    expect(readlinkSync(stableCommand)).toBe(path.join(monkeHome, "current", "mt"));
    const activeRoot = realpathSync(path.join(monkeHome, "current"));
    expect(realpathSync(stableCommand)).toBe(path.join(activeRoot, "mt"));

    const manifest = object({ sourceCheckout: string(), toolBuildIdentity: string() }).parse(
      JSON.parse(readFileSync(path.join(activeRoot, "install-manifest.json"), "utf-8"))
    );

    const shortCommit = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8"
    }).stdout.slice(0, 7);

    expect(manifest.toolBuildIdentity).toBe(`local+${shortCommit}${sourceDirty ? "-dirty" : ""}`);
    const version = spawnSync(stableCommand, ["--version"], { encoding: "utf-8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(manifest.toolBuildIdentity);
    expect(manifest.sourceCheckout).toBe(path.resolve(projectRoot));
    // This test compiles the CLI into a native executable, which can exceed the default 5s budget.
  }, 60_000);
});
