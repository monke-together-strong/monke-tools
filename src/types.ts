import type { ReleaseCatalogEntry } from "./release-catalog-schema.ts";
import type { SessionRepoState } from "./state-schema.ts";

export interface Runtime {
  /** Architecture of the machine running this command. */
  readonly architecture: string;
  /** Current working directory used by monke-tools operations. */
  readonly cwd: string;
  /** Process environment used by monke-tools operations. */
  readonly env: Record<string, string | undefined>;
  /** Run a command with the runtime environment. */
  exec: (command: string, args?: string[], options?: ExecOptions) => ExecResult;
  /** Run a command without blocking independent startup work. */
  execAsync: (command: string, args?: string[], options?: ExecOptions) => Promise<ExecResult>;
  /** Optional injected activation boundary used to prove atomic failure behavior. */
  readonly installationActivationBoundary?: (phase: InstallationActivationPhase) => void;
  /** Select multiple values from an interactive terminal picker. */
  multiSelect: (prompt: MultiSelectPrompt) => Promise<string[]>;
  /** Operating system of the machine running this command. */
  readonly platform: NodeJS.Platform;
  /** Read one interactive input line after writing a prompt. */
  readLine: (prompt: string) => string;
  /** Official Release catalog and asset download boundary. */
  readonly releaseDistribution: ReleaseDistribution;
  /** Select one value from an interactive terminal picker. */
  select: (prompt: SelectPrompt) => Promise<string>;
  /** Whether status output is connected to an interactive terminal. */
  readonly stderrIsTTY: boolean;
  /** Identity compiled into this mt executable. */
  readonly toolBuildIdentity: string;
  /** Root of the versioned tool install resolved once when the command starts. */
  readonly toolInstallRoot: string;
  /** Write CLI output to stderr. */
  writeStderr: (text: string) => void;
  /** Write CLI output to stdout. */
  writeStdout: (text: string) => void;
}

export type InstallationActivationPhase = "final-rename" | "pointer-replacement";

export interface ReleaseDistribution {
  /** Download one asset selected from an official GitHub Release. */
  downloadReleaseAsset: (url: string) => Promise<Uint8Array>;
  /** List one 100-item page from the official GitHub Releases catalog. */
  listReleases: (page: number) => Promise<ReleaseCatalogEntry[]>;
}

export interface ExecOptions {
  allowFailure?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Text passed to the child process on stdin. */
  stdin?: string;
  /** Positive timeout in seconds before the child process is terminated. */
  timeoutSeconds?: number;
}

export interface ExecResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  /** True when the process was terminated because its timeout elapsed. */
  timedOut?: boolean;
}

export interface SelectPrompt {
  initialValue?: string;
  maxItems?: number;
  message: string;
  options: SelectOption[];
}

export interface MultiSelectPrompt {
  initialValues?: string[];
  maxItems?: number;
  message: string;
  options: SelectOption[];
  required?: boolean;
}

export interface SelectOption {
  hint?: string;
  label: string;
  value: string;
}

export interface RepoContext {
  currentBranch: string;
  cwd: string;
  gitCommonDir: string;
  isSourceCheckout: boolean;
  sessionName: string | null;
  sourceRoot: string;
  worktreeRoot: string;
}

export interface LocalMapping {
  portKey: string;
  targetApp: string;
  targetEnv: string;
}

export interface ExternalMapping {
  dependencyLabel: string;
  dependencyRoot: string;
  portKey: string;
  targetApp: string;
  targetEnv: string;
}

export interface AppConfig {
  absoluteAppPath: string;
  label: string;
  localMappings: LocalMapping[];
  relativeEnvFile: string;
  relativePath: string;
}

export interface ExternalRepoConfig {
  absoluteRepoRoot: string;
  label: string;
  mappings: ExternalMapping[];
  pathEnv: string;
  relativePath: string;
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
  /** Uppercase environment variable names the function must return. */
  outputs: string[];
  /** Repo-relative JS/TS module path run from the target session worktree. */
  run: string;
  /** Positive timeout in seconds for the Resource command. */
  timeoutSeconds: number;
}

export interface RepoConfig {
  appsByLabel: Map<string, AppConfig>;
  appsInOrder: AppConfig[];
  bootstrapCommand?: string;
  /** Repo-owned command run during Cleanup for dead session worktrees. */
  cleanupCommand?: string;
  configPath: string;
  externalInOrder: ExternalRepoConfig[];
  externalMappingsInOrder: ExternalMapping[];
  externalTargetApps: Set<string>;
  localMappingsByPort: Map<string, LocalMapping[]>;
  localPortOrder: string[];
  /** Dynamic Resource commands declared by this repo, in YAML order. */
  resourceCommandsInOrder: ResourceCommandConfig[];
  /** Deterministic Resource values declared by this repo, in YAML order. */
  resourceValuesInOrder: ResourceValueConfig[];
  seedPaths: string[];
  sourceRoot: string;
}

export interface RepoMaterializationResult {
  localAssignments: Map<string, number>;
  state: SessionRepoState;
}

export type {
  AssignedPort,
  RepoReservation,
  ResourceCommandOutputState,
  ResourceCommandState,
  ResourceValueState,
  SessionRepoState,
  SessionState
} from "./state-schema.ts";
