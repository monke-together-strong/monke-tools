import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, runMonke } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("install-dependencies remains a compatibility no-op", () => {
  const sandbox = makeTempDir("install-dependencies-noop");
  const binDirectory = path.join(sandbox, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const home = path.join(sandbox, "home");

  const result = runMonke({
    cwd: sandbox,
    args: ["install-dependencies"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });

  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Verified monke-tools runtime dependencies\n");
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
    readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf8"),
    "utf8",
  );
  chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
  writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf8");
  installFakeBun(binDirectory);

  const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      BUN_LOG: bunLog,
      MONKE_TOOLS_LOG: monkeToolsLog,
      INSTALL_DEPENDENCIES_EXIT: "17",
    },
  });

  expect(result.status).toBe(17);
  expect(readFileSync(bunLog, "utf8")).toContain(`pwd:${path.join(checkout, "builds")}\n`);
  expect(readFileSync(monkeToolsLog, "utf8")).toBe("install-dependencies\n");
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
    readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf8"),
    "utf8",
  );
  chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
  writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf8");
  installFakeBun(binDirectory);

  const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      BUN_LOG: bunLog,
      MONKE_TOOLS_LOG: monkeToolsLog,
      INSTALL_DEPENDENCIES_EXIT: "0",
    },
  });

  expect(result.status).toBe(0);
  expect(readFileSync(bunLog, "utf8")).toContain(`pwd:${path.join(checkout, "builds")}\n`);
  expect(readFileSync(monkeToolsLog, "utf8")).toBe(
    `install-dependencies\nshell install\nskills local-install ${checkout}\n`,
  );
  expect(readFileSync(path.join(home, ".local", "bin", "mt"), "utf8")).toBe(
    '#!/bin/sh\nexec "$(dirname "$0")/monke-tools" "$@"\n',
  );
  expect(readFileSync(path.join(home, ".local", "bin", "monke"), "utf8")).toBe(
    '#!/bin/sh\nexec "$(dirname "$0")/monke-tools" "$@"\n',
  );
  expect(existsSync(path.join(home, ".local", "bin", "monke-tools"))).toBe(true);
  expect(result.stdout).toContain("Installed monke-tools");
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
    readFileSync(path.join(projectRoot, "scripts", "install-local.sh"), "utf8"),
    "utf8",
  );
  chmodSync(path.join(checkout, "scripts", "install-local.sh"), 0o755);
  writeFileSync(path.join(checkout, "src", "index.ts"), "", "utf8");
  writeFileSync(path.join(buildDirectory, ".oldest.bun-build"), "oldest", "utf8");
  writeFileSync(path.join(buildDirectory, ".older.bun-build"), "older", "utf8");
  writeFileSync(path.join(buildDirectory, ".newer.bun-build"), "newer", "utf8");
  writeFileSync(path.join(buildDirectory, ".newest.bun-build"), "newest", "utf8");
  writeFileSync(path.join(buildDirectory, "manual.txt"), "keep me", "utf8");
  utimesSync(path.join(buildDirectory, ".oldest.bun-build"), new Date(0), new Date(0));
  utimesSync(path.join(buildDirectory, ".older.bun-build"), new Date(1_000), new Date(1_000));
  utimesSync(path.join(buildDirectory, ".newer.bun-build"), new Date(2_000), new Date(2_000));
  utimesSync(path.join(buildDirectory, ".newest.bun-build"), new Date(3_000), new Date(3_000));
  installFakeBun(binDirectory);

  const result = spawnSync("sh", [path.join(checkout, "scripts", "install-local.sh")], {
    cwd: checkout,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      BUN_LOG: bunLog,
      MONKE_TOOLS_LOG: monkeToolsLog,
      INSTALL_DEPENDENCIES_EXIT: "0",
    },
  });

  expect(result.status).toBe(0);
  expect(listBuildArtifacts(buildDirectory)).toEqual([".newer.bun-build", ".newest.bun-build"]);
  expect(readFileSync(path.join(buildDirectory, "manual.txt"), "utf8")).toBe("keep me");
});

function listBuildArtifacts(buildDirectory: string): string[] {
  return readdirSync(buildDirectory)
    .filter((entry) => entry.startsWith(".") && entry.endsWith(".bun-build"))
    .sort();
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
    "utf8",
  );
  chmodSync(bunPath, 0o755);
}
