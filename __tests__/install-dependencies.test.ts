import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installFakeBrew, installFakeWt, makeTempDir, read, runMonke } from "./helpers.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("install-dependencies configures shell integration when wt is already available", () => {
  const sandbox = makeTempDir("install-dependencies-existing-wt");
  const binDirectory = path.join(sandbox, "bin");
  const wtLog = installFakeWt(binDirectory);
  const home = path.join(sandbox, "home");

  const result = runMonke({
    cwd: sandbox,
    args: ["install-dependencies"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });

  expect(result.stdout).toBe("Verified monke-tools runtime dependencies\n");
  expect(readFileSync(wtLog, "utf8")).toContain("config shell install --yes");
});

test("install-dependencies fails when existing wt shell integration setup fails", () => {
  const sandbox = makeTempDir("install-dependencies-existing-wt-config-fails");
  const binDirectory = path.join(sandbox, "bin");
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    path.join(binDirectory, "wt"),
    `#!/bin/sh
printf '%s\n' "$@" >&2
exit 42
`,
    "utf8",
  );
  chmodSync(path.join(binDirectory, "wt"), 0o755);
  const home = path.join(sandbox, "home");

  expect(() => {
    runMonke({
      cwd: sandbox,
      args: ["install-dependencies"],
      monkeHome: home,
      binDirectory,
      extraEnv: { PATH: binDirectory },
    });
  }).toThrow(/config shell install --yes/);
});

test("install-dependencies installs worktrunk through Homebrew and configures shell integration when wt is missing", () => {
  const sandbox = makeTempDir("install-dependencies-brew");
  const binDirectory = path.join(sandbox, "bin");
  const brewLog = installFakeBrew(binDirectory);
  const home = path.join(sandbox, "home");

  const result = runMonke({
    cwd: sandbox,
    args: ["install-dependencies"],
    monkeHome: home,
    binDirectory,
    extraEnv: { PATH: binDirectory },
  });

  expect(result.stdout).toBe("Verified monke-tools runtime dependencies\n");
  expect(read(path.dirname(brewLog), "brew.log")).toContain("install worktrunk");
  expect(read(path.dirname(brewLog), "wt.log")).toContain("config shell install --yes");
});

test("install-dependencies fails when wt is missing and Homebrew is unavailable", () => {
  const sandbox = makeTempDir("install-dependencies-no-brew");
  const binDirectory = path.join(sandbox, "empty-bin");
  mkdirSync(binDirectory, { recursive: true });
  const home = path.join(sandbox, "home");

  expect(() => {
    runMonke({
      cwd: sandbox,
      args: ["install-dependencies"],
      monkeHome: home,
      binDirectory,
      extraEnv: { PATH: binDirectory },
    });
  }).toThrow(/Homebrew is not available/);
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
    `install-dependencies\nskills local-install ${checkout}\n`,
  );
  expect(result.stdout).toContain("Installed monke-tools");
});

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
