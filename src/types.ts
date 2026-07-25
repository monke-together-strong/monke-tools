import type {
  AssignedPort,
  RepoReservation,
  ResourceCommandOutputState,
  ResourceCommandState,
  ResourceValueState,
  SessionRepoState,
  SessionState,
} from "./state-schema.ts";

export interface Runtime {
  /** Current working directory used by monke-tools operations. */
  readonly cwd: string;
  /** Process environment used by monke-tools operations. */
  readonly env: Record<string, string | undefined>;
  /** Run a command with the runtime environment. */
  exec(command: string, args?: string[], options?: ExecOptions): ExecResult;
  /** Select one value from an interactive terminal picker. */
  select(prompt: SelectPrompt): Promise<string>;
  /** Read one interactive input line after writing a prompt. */
  readLine(prompt: string): string;
  /** Write CLI output to stdout. */
  writeStdout(text: string): void;
  /** Write CLI output to stderr. */
  writeStderr(text: string): void;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowFailure?: boolean;
  /** Text passed to the child process on stdin. */
  stdin?: string;
  /** Positive timeout in seconds before the child process is terminated. */
  timeoutSeconds?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was terminated because its timeout elapsed. */
  timedOut?: boolean;
}

export interface SelectPrompt {
  message: string;
  options: SelectOption[];
  initialValue?: string;
  maxItems?: number;
}

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface RepoContext {
  cwd: string;
  worktreeRoot: string;
  sourceRoot: string;
  gitCommonDir: string;
  currentBranch: string;
  isSourceCheckout: boolean;
  sessionName: string | null;
}

export interface LocalMapping {
  targetApp: string;
  targetEnv: string;
  portKey: string;
}

export interface ExternalMapping {
  dependencyLabel: string;
  dependencyRoot: string;
  portKey: string;
  targetApp: string;
  targetEnv: string;
}

export interface AppConfig {
  label: string;
  relativePath: string;
  relativeEnvFile: string;
  absoluteAppPath: string;
  localMappings: LocalMapping[];
}

export interface ExternalRepoConfig {
  label: string;
  relativePath: string;
  pathEnv: string;
  absoluteRepoRoot: string;
  mappings: ExternalMapping[];
}

/** A deterministic Resource value declared by one repo in monke.yml. */
export interface ResourceValueConfig {
  /** Uppercase environment variable name written to the session root .env. */
  env: string;
  /** Literal value template supporting ${session} and ${user}. */
  literal: string;
}

/** A dynamic Resource command declared by one repo in monke.yml. */
export interface ResourceCommandConfig {
  /** Lowercase command label used as the Resource command namespace. */
  name: string;
  /** Repo-relative JS/TS module path run from the target session worktree. */
  run: string;
  /** Positive timeout in seconds for the Resource command. */
  timeoutSeconds: number;
  /** Uppercase environment variable names the function must return. */
  outputs: string[];
}

export interface RepoConfig {
  sourceRoot: string;
  configPath: string;
  bootstrapCommand?: string;
  /** Repo-owned command run during Cleanup for dead session worktrees. */
  cleanupCommand?: string;
  seedPaths: string[];
  /** Deterministic Resource values declared by this repo, in YAML order. */
  resourceValuesInOrder: ResourceValueConfig[];
  /** Dynamic Resource commands declared by this repo, in YAML order. */
  resourceCommandsInOrder: ResourceCommandConfig[];
  appsInOrder: AppConfig[];
  appsByLabel: Map<string, AppConfig>;
  externalInOrder: ExternalRepoConfig[];
  localPortOrder: string[];
  localMappingsByPort: Map<string, LocalMapping[]>;
  externalMappingsInOrder: ExternalMapping[];
  externalTargetApps: Set<string>;
}

export interface ResolvedGraph {
  rootSourceRoot: string;
  reposInMaterializationOrder: RepoConfig[];
  reposByRoot: Map<string, RepoConfig>;
}

export interface RepoMaterializationResult {
  state: SessionRepoState;
  localAssignments: Map<string, number>;
}

export type {
  AssignedPort,
  RepoReservation,
  ResourceCommandOutputState,
  ResourceCommandState,
  ResourceValueState,
  SessionRepoState,
  SessionState,
} from "./state-schema.ts";
