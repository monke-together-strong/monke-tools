import type { ReleaseCatalogEntry } from "./release-catalog-schema.ts";
import type { SessionRepoState } from "./state-schema.ts";

export interface Runtime {
  readonly architecture: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /**
   * Run a command; throws MonkeError on non-zero exit, signal, or timeout unless `allowFailure` is
   * true.
   */
  exec: (command: string, args?: string[], options?: ExecOptions) => ExecResult;
  execAsync: (command: string, args?: string[], options?: ExecOptions) => Promise<ExecResult>;
  /** Optional injected activation boundary used to prove atomic failure behavior. */
  readonly installationActivationBoundary?: (phase: InstallationActivationPhase) => void;
  multiSelect: (prompt: MultiSelectPrompt) => Promise<string[]>;
  readonly platform: NodeJS.Platform;
  readLine: (prompt: string) => string;
  readonly releaseDistribution: ReleaseDistribution;
  select: (prompt: SelectPrompt) => Promise<string>;
  /** Optional injected boundary invoked immediately after a Session checkpoint is persisted. */
  readonly sessionMaterializationBoundary?: (checkpoint: SessionMaterializationCheckpoint) => void;
  readonly stderrIsTTY: boolean;
  /** Identity compiled into this mt executable. */
  readonly toolBuildIdentity: string;
  /** Root of the versioned tool install resolved once when the command starts. */
  readonly toolInstallRoot: string;
  writeStderr: (text: string) => void;
  writeStdout: (text: string) => void;
}

export type InstallationActivationPhase = "final-rename" | "pointer-replacement";

export type SessionMaterializationCheckpoint =
  | "cleanup-obligation"
  | "generation-completion"
  | "generation-start"
  | "preparation"
  | "repo-progress"
  | "repo-result"
  | "resource-command-output"
  | "worktree-ready";

export interface ReleaseDistribution {
  /** Open a streaming response for one asset selected from an official GitHub Release. */
  downloadReleaseAsset: (url: string) => Promise<Response>;
  /** List one 100-item page from the official GitHub Releases catalog. */
  listReleases: (page: number) => Promise<ReleaseCatalogEntry[]>;
}

export interface ExecOptions {
  allowFailure?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  inheritStdio?: boolean;
  protectProcessGroup?: (pid: number) => void;
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
  portKey: string;
  targetApp: string;
  targetEnv: string;
}

export interface AppConfig {
  absoluteAppPath: string;
  label: string;
  localMappings: LocalMapping[];
  relativeEnvFile: string;
}

export interface ExternalRepoConfig {
  absoluteRepoRoot: string;
  label: string;
  mappings: ExternalMapping[];
  pathEnv: string;
}

export interface ResourceValueConfig {
  /** Uppercase environment variable name written to the owning checkout's root .env. */
  env: string;
  /** Literal value template supporting ${session}, ${user}, and ${id}. */
  literal: string;
}

export interface ResourceCommandConfig {
  acquire?: "automatic" | "explicit";
  /** Lowercase command label used as the Resource command namespace. */
  name: string;
  /** Uppercase environment variable names the module's `acquire` function must return. */
  outputs: string[];
  /** Repo-relative JS/TS module path run from the owning checkout. */
  run: string;
  /** Positive timeout in seconds for the Resource command. */
  timeoutSeconds: number;
}

export interface RepoConfig {
  appsInOrder: AppConfig[];
  bootstrapCommand?: string;
  /**
   * Repo-owned shell command that satisfies the repo's Cleanup obligation; runs from the Session
   * worktree before worktree removal.
   */
  cleanupCommand?: string;
  configPath: string;
  externalInOrder: ExternalRepoConfig[];
  externalMappingsInOrder: ExternalMapping[];
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
  ResourceCommandState,
  ResourceValueState,
  SessionRepoState,
  SessionState
} from "./state-schema.ts";
