import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach } from "vite-plus/test";
import { parse } from "yaml";
import type * as z from "zod";

import { runCli, runCliAsync } from "../src/index.ts";
import { createRuntime } from "../src/runtime.ts";
import type { SelectPrompt } from "../src/types.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined && directory !== "") {
      rmSync(directory, { force: true, recursive: true });
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

export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function write(root: string, relativePath: string, contents: string): void {
  const targetPath = path.join(root, relativePath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf-8");
}

export function read(root: string, relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf-8");
}

export function installGitShim(
  binDirectory: string,
  options?: {
    afterCommand?: {
      args: string;
      cwd?: string;
      occurrence?: number;
      script: string;
    };
    failCommand?: {
      args: string;
      message?: string;
    };
  }
): string {
  const logPath = path.join(binDirectory, "git.log");
  const failCommand =
    options?.failCommand === undefined
      ? ""
      : `if [ "$*" = ${shellQuote(options.failCommand.args)} ]; then
  printf '%s\\n' ${shellQuote(options.failCommand.message ?? "injected Git failure")} >&2
  exit 23
fi
`;
  const afterCommand =
    options?.afterCommand === undefined
      ? ""
      : `if [ "$*" = ${shellQuote(options.afterCommand.args)} ]${
          options.afterCommand.cwd === undefined
            ? ""
            : ` && [ "$(pwd -P)" = ${shellQuote(options.afterCommand.cwd)} ]`
        }; then
  "${findExecutableOnPath("git")}" "$@"
  status=$?
  MONKE_TEST_REAL_GIT=${shellQuote(findExecutableOnPath("git"))}
  export MONKE_TEST_REAL_GIT
  count_file=${shellQuote(path.join(binDirectory, "git-hook-count"))}
  count="$(cat "$count_file" 2>/dev/null || printf '0')"
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -eq ${String(options.afterCommand.occurrence ?? 1)} ]; then
    ${options.afterCommand.script}
  fi
  exit "$status"
fi
`;
  writeExecutable(
    path.join(binDirectory, "git"),
    `#!/bin/sh
first_arg=true
for arg in "$@"; do
  if [ "$first_arg" = true ]; then
    first_arg=false
  else
    printf ' ' >> ${shellQuote(logPath)}
  fi
  printf '%s' "$arg" >> ${shellQuote(logPath)}
done
printf '\\n' >> ${shellQuote(logPath)}
${failCommand}
${afterCommand}
exec "${findExecutableOnPath("git")}" "$@"
`
  );
  return logPath;
}

export function installShShim(binDirectory: string): string {
  const logPath = path.join(binDirectory, "sh.log");
  writeExecutable(
    path.join(binDirectory, "sh"),
    `#!/bin/sh
printf '%s\n' "$@" >> ${shellQuote(logPath)}
if [ "\${1:-}" = "-lc" ]; then
  echo "repo commands must not use a login shell" >&2
  exit 42
fi
exec /bin/sh "$@"
`
  );
  return logPath;
}

export function installCodexUrlOpenShim(binDirectory: string): string {
  const logPath = path.join(binDirectory, "open-url.log");
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  writeExecutable(
    path.join(binDirectory, command),
    `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> ${shellQuote(logPath)}
`
  );
  return logPath;
}

export function installWindowsCmdShim(binDirectory: string): string {
  const logPath = path.join(binDirectory, "cmd.log");
  writeExecutable(
    path.join(binDirectory, "cmd"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> ${shellQuote(logPath)}
`
  );
  return logPath;
}

export function installFakeGh(
  binDirectory: string,
  issues: Record<number, { title: string; body: string; comments?: readonly string[] }>
): string {
  const logPath = path.join(binDirectory, "gh.log");
  const issueCases = Object.entries(issues)
    .map(([issueNumber, issue]) => {
      const issueJson = JSON.stringify({
        body: issue.body,
        comments: (issue.comments ?? []).map((body) => ({ body })),
        number: Math.trunc(Number(issueNumber)),
        title: issue.title,
      });
      return `    ${issueNumber}) printf '%s\\n' ${shellQuote(issueJson)}; exit 0 ;;`;
    })
    .join("\n");
  const script = `#!/bin/sh
set -eu
first_arg=true
for arg in "$@"; do
  if [ "$first_arg" = true ]; then
    first_arg=false
  else
    printf ' ' >> ${shellQuote(logPath)}
  fi
  printf '%s' "$arg" >> ${shellQuote(logPath)}
done
printf '\\n' >> ${shellQuote(logPath)}
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "owner/repo"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
${issueCases}
  esac
fi
if [ "$1" = "issue" ] && [ "$2" = "close" ]; then
  exit 0
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`;
  writeExecutable(path.join(binDirectory, "gh"), script);
  return logPath;
}

export function installFakeGhForMergedPrs(
  binDirectory: string,
  options: {
    repo: string;
    prsByHead: Record<string, unknown[]>;
  }
): string {
  const logPath = path.join(binDirectory, "gh.log");
  const cases = Object.entries(options.prsByHead)
    .map(
      ([head, prs]) =>
        `    ${shellQuote(head)}) printf '%s\\n' ${shellQuote(JSON.stringify(prs))}; exit 0 ;;`
    )
    .join("\n");
  const script = `#!/bin/sh
set -eu
first_arg=true
for arg in "$@"; do
  if [ "$first_arg" = true ]; then
    first_arg=false
  else
    printf ' ' >> ${shellQuote(logPath)}
  fi
  printf '%s' "$arg" >> ${shellQuote(logPath)}
done
printf '\\n' >> ${shellQuote(logPath)}
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf '%s\\n' ${shellQuote(JSON.stringify({ nameWithOwner: options.repo }))}
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  head=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--head" ]; then
      head="$arg"
    fi
    previous="$arg"
  done
  case "$head" in
${cases}
    *) printf '[]\\n'; exit 0 ;;
  esac
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`;
  writeExecutable(path.join(binDirectory, "gh"), script);
  return logPath;
}

interface RunMonkeOptions {
  cwd: string;
  args: string[];
  monkeHome: string;
  binDirectory?: string;
  extraEnv?: Record<string, string | undefined>;
}

function captureMonkeRun(options: RunMonkeOptions): {
  output: () => { stdout: string; stderr: string };
  runtime: ReturnType<typeof createRuntime>;
} {
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
    onStderr(text) {
      stderr += text;
    },
    onStdout(text) {
      stdout += text;
    },
  });
  return {
    output: () => ({ stderr, stdout }),
    runtime,
  };
}

export function runMonke(options: RunMonkeOptions): { stdout: string; stderr: string } {
  const captured = captureMonkeRun(options);

  runCli(options.args, captured.runtime);
  return captured.output();
}

export function runMonkeCapturingFailure(options: RunMonkeOptions): {
  error: unknown;
  stdout: string;
  stderr: string;
} {
  const captured = captureMonkeRun(options);

  try {
    runCli(options.args, captured.runtime);
    return { error: null, ...captured.output() };
  } catch (error) {
    return { error, ...captured.output() };
  }
}

export async function runMonkeAsync(options: {
  cwd: string;
  args: string[];
  monkeHome: string;
  binDirectory?: string;
  extraEnv?: Record<string, string | undefined>;
  selectValues?: string[];
  onSelect?: (prompt: SelectPrompt) => void;
}): Promise<{ stdout: string; stderr: string }> {
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
    onSelect: options.onSelect,
    onStderr(text) {
      stderr += text;
    },
    onStdout(text) {
      stdout += text;
    },
    selectValues: options.selectValues,
  });

  await runCliAsync(options.args, runtime);
  return { stderr, stdout };
}

export function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

export function readSingleYamlFile<T extends z.ZodType>(
  directoryPath: string,
  schema: T
): z.output<T>;
export function readSingleYamlFile(directoryPath: string): unknown;
export function readSingleYamlFile(directoryPath: string, schema?: z.ZodType): unknown {
  const entries = readdirSync(directoryPath).filter((entry) => entry.endsWith(".yml"));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one yaml file in ${directoryPath}, found ${entries.length}`);
  }
  const [entry] = entries;
  if (entry === undefined) {
    throw new Error(`Expected one yaml file in ${directoryPath}`);
  }
  const value: unknown = parse(readFileSync(path.join(directoryPath, entry), "utf-8"));
  return schema ? schema.parse(value) : value;
}

function writeExecutable(targetPath: string, contents: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, contents, "utf-8");
  chmodSync(targetPath, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function findExecutableOnPath(command: string): string {
  const pathValue = process.env.PATH ?? "";
  for (const segment of pathValue.split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    const candidate = path.join(segment, command);
    try {
      return realpathSync.native(candidate);
    } catch {
      continue;
    }
  }

  throw new Error(`Could not find ${command} on PATH`);
}
