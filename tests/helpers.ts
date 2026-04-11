import { afterEach } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

import { runCli } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

export function makeTempDir(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), `${prefix}-`)));
  tempDirectories.push(directory);
  return directory;
}

export function createRepo(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);

  for (const [relativePath, contents] of Object.entries(files)) {
    write(root, relativePath, contents);
  }

  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return realpathSync.native(root);
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function write(root: string, relativePath: string, contents: string): void {
  const targetPath = path.join(root, relativePath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf8");
}

export function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

export function installFakeWt(binDirectory: string): void {
  writeExecutable(path.join(binDirectory, "wt"), "#!/bin/sh\nexit 0\n");
}

export function installFakeBrew(binDirectory: string): string {
  const logPath = path.join(binDirectory, "brew.log");
  const script = `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
if [ "$1" = "install" ] && [ "$2" = "worktrunk" ]; then
  cat > "${path.join(binDirectory, "wt")}" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "${path.join(binDirectory, "wt")}"
  exit 0
fi
echo "unsupported brew invocation: $*" >&2
exit 1
`;
  writeExecutable(path.join(binDirectory, "brew"), script);
  return logPath;
}

export function runMonke(options: {
  cwd: string;
  args: string[];
  monkeHome: string;
  binDirectory?: string;
  extraEnv?: Record<string, string | undefined>;
}): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const pathSegments = [options.binDirectory ?? "", process.env.PATH ?? ""].filter(Boolean);

  const runtime = createRuntime({
    cwd: options.cwd,
    env: {
      MONKE_HOME: options.monkeHome,
      PATH: pathSegments.join(path.delimiter),
      ...options.extraEnv,
    },
    onStdout(text) {
      stdout += text;
    },
    onStderr(text) {
      stderr += text;
    },
  });

  runCli(options.args, runtime);
  return { stdout, stderr };
}

export function readSingleYamlFile(directoryPath: string): unknown {
  const entries = readdirSync(directoryPath).filter((entry) => entry.endsWith(".yml"));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one yaml file in ${directoryPath}, found ${entries.length}`);
  }
  return parse(readFileSync(path.join(directoryPath, entries[0]!), "utf8"));
}

function writeExecutable(targetPath: string, contents: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf8");
  chmodSync(targetPath, 0o755);
}
