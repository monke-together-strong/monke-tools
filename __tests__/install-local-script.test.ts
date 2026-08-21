import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";
import { object, string } from "zod";

import { makeTempDir, writeExecutable } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_ID_ARGUMENT_PATTERN = /--install-id (?<identity>\S+)/u;

function prepareInstallFixture(
  checkout: string,
  binDirectory: string,
  dirty: boolean,
  changeDuringBuild = false
) {
  const sourceChangedMarker = path.join(checkout, ".source-changed-during-build");
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(path.join(checkout, "src"), { recursive: true });
  writeFileSync(
    path.join(checkout, "scripts", "install-local.sh"),
    readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf-8"),
    "utf-8"
  );
  chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
  writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf-8");

  writeExecutable(
    path.join(binDirectory, "git"),
    `#!/bin/sh
set -eu
case "$*" in
  *"rev-parse HEAD") printf '%s\n' 0123456789abcdef0123456789abcdef01234567 ;;
  *"rev-parse --short=7 HEAD") printf '%s\n' 0123456 ;;
  *"status --porcelain --untracked-files=normal") ${dirty ? "printf '%s\\n' ' M src/index.ts'" : ":"} ;;
  *"diff --binary HEAD --") [ ! -f ${JSON.stringify(sourceChangedMarker)} ] || printf '%s\n' changed ;;
  *"ls-files --others --exclude-standard") : ;;
  *) exit 2 ;;
esac
`
  );
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
${changeDuringBuild ? `/usr/bin/touch ${JSON.stringify(sourceChangedMarker)}` : ""}
`
  );
}

describe("Local install refresh script", () => {
  test("recovers an installation lock left by a dead process", () => {
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
  });

  test("builds a unique versioned Local install and delegates activation with provenance", () => {
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

  test("two builds from the same commit receive distinct install identities", () => {
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

  test("aborts before activation when the source changes during compilation", () => {
    const sandbox = makeTempDir("install-local-source-change");
    const checkout = path.join(sandbox, "checkout");
    const binDirectory = path.join(sandbox, "bin");
    const monkeHome = path.join(sandbox, "monke-home");
    const monkeToolsLog = path.join(sandbox, "monke-tools.log");
    prepareInstallFixture(checkout, binDirectory, false, true);

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

  test("compiled Local executables report their Tool build identity", () => {
    const sandbox = makeTempDir("install-local-version");
    const executablePath = path.join(sandbox, "mt");
    const build = spawnSync(
      "bun",
      [
        "build",
        "--compile",
        "--define",
        'process.env.MONKE_TOOLS_BUILD_IDENTITY="local+0123456-dirty"',
        "--outfile",
        executablePath,
        path.join(projectRoot, "src", "index.ts")
      ],
      { cwd: projectRoot, encoding: "utf-8" }
    );
    expect(build.status).toBe(0);

    const version = spawnSync(executablePath, ["--version"], { encoding: "utf-8" });
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("local+0123456-dirty\n");
  });

  test("the real Local refresh activates the compiled executable through the stable symlink", () => {
    const sandbox = makeTempDir("install-local-end-to-end");
    const home = path.join(sandbox, "home");
    const monkeHome = path.join(sandbox, "monke-home");
    const binDirectory = path.join(sandbox, "bin");
    writeExecutable(
      path.join(binDirectory, "codiff"),
      "#!/bin/sh\nprintf '%s\\n' 'codiff v1.10.1'\n"
    );

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
    const version = spawnSync(stableCommand, ["--version"], { encoding: "utf-8" });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(manifest.toolBuildIdentity);
    expect(manifest.sourceCheckout).toBe(path.resolve(projectRoot));
  });
});
