import { afterEach } from "vitest";
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

export function installGitShim(binDirectory: string): void {
  writeExecutable(
    path.join(binDirectory, "git"),
    `#!/bin/sh\nexec "${findExecutableOnPath("git")}" "$@"\n`,
  );
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
`,
  );
  return logPath;
}

export function installFakeBrew(binDirectory: string): string {
  const logPath = path.join(binDirectory, "brew.log");
  const wtLogPath = path.join(binDirectory, "wt.log");
  const script = `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
if [ "$1" = "install" ] && [ "$2" = "worktrunk" ]; then
  /bin/cat > "${path.join(binDirectory, "wt")}" <<'EOF'
#!/bin/sh
echo "$@" >> "${wtLogPath}"
exit 0
EOF
  /bin/chmod +x "${path.join(binDirectory, "wt")}"
  exit 0
fi
echo "unsupported brew invocation: $*" >&2
exit 1
`;
  writeExecutable(path.join(binDirectory, "brew"), script);
  return logPath;
}

export function installFailingBrew(binDirectory: string): string {
  const logPath = path.join(binDirectory, "brew.log");
  const script = `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
echo "brew install failed" >&2
exit 1
`;
  writeExecutable(path.join(binDirectory, "brew"), script);
  return logPath;
}

export function installNoopBrew(binDirectory: string): string {
  const logPath = path.join(binDirectory, "brew.log");
  const script = `#!/bin/sh
set -eu
echo "$@" >> "${logPath}"
exit 0
`;
  writeExecutable(path.join(binDirectory, "brew"), script);
  return logPath;
}

export function installFakeCodex(
  binDirectory: string,
  options?: {
    stdoutText?: string;
    stderrText?: string;
    exitCode?: number;
    jsonOutput?: string;
    removeJsonOutput?: boolean;
    cleanup?: {
      stdoutText?: string;
      stderrText?: string;
      exitCode?: number;
      commitMessage?: string;
      stageAll?: boolean;
    };
    implementer?: {
      stdoutText?: string;
      stderrText?: string;
      exitCode?: number;
      commitMessage?: string;
      dirtyFilePath?: string;
      dirtyFileContents?: string;
    };
    reviewer?: {
      stdoutText?: string;
      stderrText?: string;
      exitCode?: number;
      commitMessage?: string;
    };
    finalPrdReviewer?: {
      stdoutText?: string;
      stderrText?: string;
      exitCode?: number;
      commitMessage?: string;
    };
  },
): {
  argsLogPath: string;
  cwdLogPath: string;
  stdinLogPath: string;
  invocationCountPath: string;
  phaseLogPath: string;
  schemaLogPath: string;
} {
  const argsLogPath = path.join(binDirectory, "codex-args.log");
  const cwdLogPath = path.join(binDirectory, "codex-cwd.log");
  const stdinLogPath = path.join(binDirectory, "codex-stdin.log");
  const invocationCountPath = path.join(binDirectory, "codex-count.log");
  const phaseLogPath = path.join(binDirectory, "codex-phase.log");
  const schemaLogPath = path.join(binDirectory, "codex-schema.log");
  const defaultStdoutText = options?.stdoutText ?? "fake codex stdout";
  const defaultStderrText = options?.stderrText ?? "fake codex stderr";
  const defaultExitCode = options?.exitCode ?? 0;
  const jsonOutput = options?.jsonOutput ?? "";
  const removeJsonOutput = options?.removeJsonOutput === true ? "true" : "false";
  const cleanupStdoutText = options?.cleanup?.stdoutText ?? defaultStdoutText;
  const cleanupStderrText = options?.cleanup?.stderrText ?? defaultStderrText;
  const cleanupExitCode = options?.cleanup?.exitCode ?? defaultExitCode;
  const cleanupCommitMessage = options?.cleanup?.commitMessage ?? "";
  const cleanupStageAll = options?.cleanup?.stageAll ?? true;
  const implementerStdoutText = options?.implementer?.stdoutText ?? defaultStdoutText;
  const implementerStderrText = options?.implementer?.stderrText ?? defaultStderrText;
  const implementerExitCode = options?.implementer?.exitCode ?? defaultExitCode;
  const implementerCommitMessage = options?.implementer?.commitMessage ?? "";
  const implementerDirtyFilePath = options?.implementer?.dirtyFilePath ?? "";
  const implementerDirtyFileContents = options?.implementer?.dirtyFileContents ?? "";
  const reviewerStdoutText = options?.reviewer?.stdoutText ?? defaultStdoutText;
  const reviewerStderrText = options?.reviewer?.stderrText ?? defaultStderrText;
  const reviewerExitCode = options?.reviewer?.exitCode ?? defaultExitCode;
  const reviewerCommitMessage = options?.reviewer?.commitMessage ?? "";
  const finalPrdReviewerStdoutText = options?.finalPrdReviewer?.stdoutText ?? defaultStdoutText;
  const finalPrdReviewerStderrText = options?.finalPrdReviewer?.stderrText ?? defaultStderrText;
  const finalPrdReviewerExitCode = options?.finalPrdReviewer?.exitCode ?? defaultExitCode;
  const finalPrdReviewerCommitMessage = options?.finalPrdReviewer?.commitMessage ?? "";

  const script = `#!/bin/sh
set -eu
count=0
if [ -f ${shellQuote(invocationCountPath)} ]; then
  count=$(/bin/cat ${shellQuote(invocationCountPath)})
fi
count=$((count + 1))
printf '%s' "$count" > ${shellQuote(invocationCountPath)}
printf '%s\n' "$PWD" >> ${shellQuote(cwdLogPath)}
printf '%s\n' "$@" >> ${shellQuote(argsLogPath)}
stdin_file="$(dirname ${shellQuote(stdinLogPath)})/codex-stdin-$count.log"
/bin/cat > "$stdin_file"
/bin/cat "$stdin_file" >> ${shellQuote(stdinLogPath)}
printf '\n<<<END-OF-INVOKE-%s>>>\n' "$count" >> ${shellQuote(stdinLogPath)}

json_output=${shellQuote(jsonOutput)}
remove_json_output=${shellQuote(removeJsonOutput)}
output_file=""
schema_file=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then
    output_file="$arg"
  fi
  if [ "$previous" = "--output-schema" ]; then
    schema_file="$arg"
  fi
  previous="$arg"
done
if [ -n "$schema_file" ]; then
  /bin/cat "$schema_file" >> ${shellQuote(schemaLogPath)}
fi
if [ -n "$output_file" ] && [ -n "$json_output" ]; then
  printf '%s' "$json_output" > "$output_file"
fi
if [ -n "$output_file" ] && [ "$remove_json_output" = "true" ]; then
  /bin/rm -f "$output_file"
fi

phase="implementer"
if /usr/bin/grep -q "You are the cleanup checkpointing phase." "$stdin_file"; then
  phase="cleanup"
elif /usr/bin/grep -q "<<<MONKE_PRD_INPUT_START>>>" "$stdin_file"; then
  phase="planner"
elif /usr/bin/grep -q "You are the Final PRD Reviewer for a completed PRD-driven workflow." "$stdin_file"; then
  phase="final-prd-reviewer"
elif /usr/bin/grep -q "# Explicit review target" "$stdin_file"; then
  phase="reviewer"
elif /usr/bin/grep -q "You are a reviewer for one GitHub issue in a PRD-driven" "$stdin_file"; then
  phase="reviewer"
fi
printf '%s\n' "$phase" >> ${shellQuote(phaseLogPath)}

if [ "$phase" = "planner" ]; then
  printf '%s\n' ${shellQuote(defaultStdoutText)}
  printf '%s\n' ${shellQuote(defaultStderrText)} >&2
  exit ${defaultExitCode}
fi

if [ "$phase" = "cleanup" ]; then
  if [ -n ${shellQuote(cleanupCommitMessage)} ]; then
    if [ ${cleanupStageAll} = true ]; then
      git add -A >/dev/null 2>&1
    fi
    git commit -m ${shellQuote(cleanupCommitMessage)} >/dev/null 2>&1 || true
  fi
  printf '%s\n' ${shellQuote(cleanupStdoutText)}
  printf '%s\n' ${shellQuote(cleanupStderrText)} >&2
  exit ${cleanupExitCode}
fi

if [ "$phase" = "reviewer" ]; then
  if [ -n ${shellQuote(reviewerCommitMessage)} ]; then
    git commit --allow-empty -m ${shellQuote(reviewerCommitMessage)} >/dev/null 2>&1 || true
  fi
  printf '%s\n' ${shellQuote(reviewerStdoutText)}
  printf '%s\n' ${shellQuote(reviewerStderrText)} >&2
  exit ${reviewerExitCode}
fi

if [ "$phase" = "final-prd-reviewer" ]; then
  if [ -n ${shellQuote(finalPrdReviewerCommitMessage)} ]; then
    git commit --allow-empty -m ${shellQuote(finalPrdReviewerCommitMessage)} >/dev/null 2>&1 || true
  fi
  printf '%s\n' ${shellQuote(finalPrdReviewerStdoutText)}
  printf '%s\n' ${shellQuote(finalPrdReviewerStderrText)} >&2
  exit ${finalPrdReviewerExitCode}
fi

if [ -n ${shellQuote(implementerCommitMessage)} ]; then
  git commit --allow-empty -m ${shellQuote(implementerCommitMessage)} >/dev/null 2>&1 || true
fi
if [ -n ${shellQuote(implementerDirtyFilePath)} ]; then
  /bin/mkdir -p "$(dirname ${shellQuote(implementerDirtyFilePath)})"
  printf '%s' ${shellQuote(implementerDirtyFileContents)} > ${shellQuote(implementerDirtyFilePath)}
fi
printf '%s\n' ${shellQuote(implementerStdoutText)}
printf '%s\n' ${shellQuote(implementerStderrText)} >&2
exit ${implementerExitCode}
`;
  writeExecutable(path.join(binDirectory, "codex"), script);
  return {
    argsLogPath,
    cwdLogPath,
    stdinLogPath,
    invocationCountPath,
    phaseLogPath,
    schemaLogPath,
  };
}

export function installFakeGh(
  binDirectory: string,
  issues: Record<number, { title: string; body: string; comments?: readonly string[] }>,
): string {
  const logPath = path.join(binDirectory, "gh.log");
  const issueCases = Object.entries(issues)
    .map(([issueNumber, issue]) => {
      const issueJson = JSON.stringify({
        number: Number.parseInt(issueNumber, 10),
        title: issue.title,
        body: issue.body,
        comments: (issue.comments ?? []).map((body) => ({ body })),
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
