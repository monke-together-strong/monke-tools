#!/usr/bin/env bun

import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import type { OptionValues } from '@commander-js/extra-typings';
import { existsSync, readFileSync } from "node:fs";
import { BetterStackApiError, BetterStackClient, normalizeQueryUrl } from './client';
import type { BetterStackConnectionsResponse, BetterStackSourceResponse } from './client';
import { getFirstEnvValue, loadEnvFileIfPresent } from "./env";

async function main(): Promise<void> {
  const program = createProgram();
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

function createProgram(): Command {
  const program = new Command()
    .name("betterstack")
    .description("Run Better Stack source and query commands through the shared HTTP CLI.")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .addHelpText(
      "after",
      `
Environment:
  Source API token:
    BETTER_STACK_TOKEN
    BETTERSTACK_API_TOKEN

  Query API credentials:
    BETTERSTACK_QUERY_URL or BETTERSTACK_SQL_URL
    BETTERSTACK_QUERY_HOST or BETTERSTACK_SQL_HOST
    BETTERSTACK_QUERY_USERNAME or BETTERSTACK_SQL_USERNAME
    BETTERSTACK_QUERY_PASSWORD or BETTERSTACK_SQL_PASSWORD

Notes:
  - If --env-file is omitted, BETTERSTACK_ENV_FILE is loaded when set.
  - If neither is set and .env.demo exists, it will be loaded automatically.
  - query run validates that the query connection matches the requested source when a metadata token is available.
  - query run forwards the SQL text unchanged to Better Stack.`
    );

  const source = program.command("source").description("Inspect Better Stack sources.");
  createPaginatedListCommand(source, "List Better Stack sources.").action(handleSourceList);
  createSourceGetCommand(source).action(handleSourceGet);

  const connection = program.command("connection").description("Inspect Better Stack connections.");
  createPaginatedListCommand(connection, "List Better Stack connections.").action(
    handleConnectionList,
  );

  const query = program.command("query").description("Run Better Stack SQL queries.");
  createQueryRunCommand(query).action(handleQueryRun);

  return program;
}

function createPaginatedListCommand(parent: Command, description: string) {
  return addCredentialOptions(
    parent
      .command("list")
      .description(description)
      .option("--page <number>", "Page number.", parseIntegerOption)
      .option("--per-page <number>", "Results per page.", parseIntegerOption),
  );
}

function createSourceGetCommand(parent: Command) {
  return addCredentialOptions(
    parent
      .command("get")
      .description("Fetch one Better Stack source.")
      .requiredOption("--id <number>", "Better Stack source id.", parseIntegerOption),
  );
}

function createQueryRunCommand(parent: Command) {
  return addCredentialOptions(
    parent
      .command("run")
      .description("Run SQL against a Better Stack source.")
      .requiredOption("--source-id <number>", "Better Stack source id.", parseIntegerOption)
      .requiredOption("--table <name>", "Better Stack SQL table name.")
      .option("--sql <query>", "Inline SQL text.")
      .option("--sql-file <path>", "Path to a file containing SQL text.")
      .option("--stdin", "Read SQL text from stdin.")
      .option("--url <url>", "Better Stack query endpoint URL.")
      .option("--host <host>", "Better Stack query endpoint host.")
      .option("--username <username>", "Better Stack query username.")
      .option("--password <password>", "Better Stack query password."),
    "Better Stack source API token for metadata validation.",
  );
}

function addCredentialOptions<
  Args extends unknown[],
  Options extends OptionValues,
  GlobalOptions extends OptionValues,
>(
  command: Command<Args, Options, GlobalOptions>,
  tokenDescription = "Better Stack source API token.",
) {
  return command
    .option("--token <token>", tokenDescription)
    .option("--env-file <path>", "Env file to load before resolving credentials.");
}

type PaginationCommand = ReturnType<typeof createPaginatedListCommand>;
type PaginationOptions = ReturnType<PaginationCommand["opts"]>;
type SourceGetCommand = ReturnType<typeof createSourceGetCommand>;
type SourceGetOptions = ReturnType<SourceGetCommand["opts"]>;
type QueryRunCommand = ReturnType<typeof createQueryRunCommand>;
type QueryRunOptions = ReturnType<QueryRunCommand["opts"]>;

function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("must be an integer.");
  }

  return parsed;
}

function initializeEnvironment(envFilePath?: string): void {
  if (envFilePath !== undefined && envFilePath !== "") {
    loadEnvFileIfPresent(envFilePath);
    return;
  }

  const defaultEnvFile = process.env.BETTERSTACK_ENV_FILE;
  if (defaultEnvFile !== undefined && defaultEnvFile !== "") {
    loadEnvFileIfPresent(defaultEnvFile);
    return;
  }

  if (existsSync(".env.demo")) {
    loadEnvFileIfPresent(".env.demo");
  }
}

async function handleSourceList(options: PaginationOptions): Promise<void> {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const {page} = options;
  const {perPage} = options;

  writeStdout(await client.listSources(page, perPage));
}

async function handleSourceGet(options: SourceGetOptions): Promise<void> {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const {id} = options;

  writeStdout(await client.getSource(id));
}

async function handleConnectionList(options: PaginationOptions): Promise<void> {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const {page} = options;
  const {perPage} = options;

  writeStdout(await client.listConnections(page, perPage));
}

async function handleQueryRun(options: QueryRunOptions): Promise<void> {
  initializeEnvironment(options.envFile);

  const { sourceId, table } = options;
  const sql = await resolveSql(options);
  const metadataToken =
    options.token ?? getFirstEnvValue(["BETTER_STACK_TOKEN", "BETTERSTACK_API_TOKEN"]);
  const resolvedCredentials = await resolveQueryCredentials(options, {
    metadataToken,
    sourceId,
    table
  });

  const response = await BetterStackClient.runQuery(resolvedCredentials, sql);

  writeStdout(response);
}

interface ResolvedQueryContext {
  metadataToken?: string;
  sourceId: number;
  table: string;
}

interface BetterStackSourceMetadata {
  dataRegion: string;
  expectedTable: string;
  sourceId: string;
  sourceName: string;
  teamId: number;
  teamName: string;
}

interface BetterStackConnectionMetadata {
  dataRegion: string;
  host: string;
  port: number;
  teamIds: number[];
  teamNames: string[];
  username: string;
}

class BetterStackResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetterStackResponseShapeError";
  }
}

async function resolveQueryCredentials(
  options: QueryRunOptions,
  context: ResolvedQueryContext
): Promise<{ password: string; url: string; username: string }> {
  const { matchingConnection, sourceMetadata } = await loadQueryMetadata(context);
  validateQueryTable(context, sourceMetadata);

  const rawUrlInput = requireQueryCredential(
    options.url ??
      options.host ??
      getFirstEnvValue([
        "BETTERSTACK_QUERY_URL",
        "BETTERSTACK_SQL_URL",
        "BETTERSTACK_QUERY_HOST",
        "BETTERSTACK_SQL_HOST"
      ]) ??
      (matchingConnection ? formatConnectionEndpoint(matchingConnection) : undefined),
    `Missing query endpoint. Provide --url/--host or set BETTERSTACK_QUERY_URL, BETTERSTACK_SQL_URL, BETTERSTACK_QUERY_HOST, or BETTERSTACK_SQL_HOST. Expected ${
      matchingConnection?.host ??
      `a Better Stack connection for team/source ${sourceMetadata?.teamName ?? context.sourceId}`
    }.`
  );
  const username = requireQueryCredential(
    options.username ??
      getFirstEnvValue(["BETTERSTACK_QUERY_USERNAME", "BETTERSTACK_SQL_USERNAME"]) ??
      matchingConnection?.username,
    "Missing query username. Provide --username or set BETTERSTACK_QUERY_USERNAME or BETTERSTACK_SQL_USERNAME."
  );
  const password = requireQueryCredential(
    options.password ??
      getFirstEnvValue(["BETTERSTACK_QUERY_PASSWORD", "BETTERSTACK_SQL_PASSWORD"]),
    "Missing query password. Provide --password or set BETTERSTACK_QUERY_PASSWORD or BETTERSTACK_SQL_PASSWORD."
  );

  const normalizedUrl = normalizeQueryUrl(rawUrlInput);

  if (sourceMetadata) {
    validateQueryEndpointMatchesSource(normalizedUrl, sourceMetadata, matchingConnection);
  } else {
    validateQueryEndpointIsAllowed(normalizedUrl);
  }

  return {
    password,
    url: normalizedUrl,
    username
  };
}

async function loadQueryMetadata(context: ResolvedQueryContext): Promise<{
  matchingConnection: BetterStackConnectionMetadata | null;
  sourceMetadata: BetterStackSourceMetadata | null;
}> {
  if (context.metadataToken === undefined || context.metadataToken === "") {
    return { matchingConnection: null, sourceMetadata: null };
  }

  const sourceMetadata = await tryLoadSourceMetadata(context.metadataToken, context.sourceId);
  const connections = await tryLoadConnections(context.metadataToken);
  const matchingConnection =
    sourceMetadata === null
      ? null
      : (connections.find(
          (connection) =>
            connection.dataRegion === sourceMetadata.dataRegion &&
            connection.teamIds.includes(sourceMetadata.teamId)
        ) ?? null);
  return { matchingConnection, sourceMetadata };
}

function validateQueryTable(
  context: ResolvedQueryContext,
  sourceMetadata: BetterStackSourceMetadata | null
): void {
  if (sourceMetadata !== null && context.table !== sourceMetadata.expectedTable) {
    fail(
      `Table mismatch for source ${sourceMetadata.sourceId}. Expected ${sourceMetadata.expectedTable}, received ${context.table}.`
    );
  }
}

function requireQueryCredential(value: string | undefined, message: string): string {
  if (value === undefined || value === "") {
    fail(message);
  }
  return value;
}

async function loadSourceMetadata(
  token: string,
  sourceId: number
): Promise<BetterStackSourceMetadata> {
  const client = createMetadataClient(token);
  const raw = await client.getSource(sourceId);
  const parsed: unknown = JSON.parse(raw);

  if (!isBetterStackSourceResponse(parsed)) {
    invalidResponse("Invalid Better Stack source response shape: expected data.attributes.");
  }

  return {
    dataRegion: parsed.data.attributes.data_region,
    expectedTable: `t${parsed.data.attributes.team_id}.${parsed.data.attributes.table_name}`,
    sourceId: parsed.data.id,
    sourceName: parsed.data.attributes.name,
    teamId: parsed.data.attributes.team_id,
    teamName: parsed.data.attributes.team_name
  };
}

async function loadConnections(token: string): Promise<BetterStackConnectionMetadata[]> {
  const client = createMetadataClient(token);
  const raw = await client.listConnections(1, 100);
  const parsed: unknown = JSON.parse(raw);

  if (!isBetterStackConnectionsResponse(parsed)) {
    invalidResponse("Invalid Better Stack connections response shape: expected data[].attributes.");
  }

  return parsed.data.map((connection) => ({
    dataRegion: connection.attributes.data_region,
    host: connection.attributes.host,
    port: connection.attributes.port,
    teamIds: connection.attributes.team_ids,
    teamNames: connection.attributes.team_names,
    username: connection.attributes.username
  }));
}

async function tryLoadSourceMetadata(
  token: string,
  sourceId: number
): Promise<BetterStackSourceMetadata | null> {
  try {
    return await loadSourceMetadata(token, sourceId);
  } catch (error) {
    if (error instanceof BetterStackResponseShapeError) {
      throw error;
    }

    return null;
  }
}

async function tryLoadConnections(token: string): Promise<BetterStackConnectionMetadata[]> {
  try {
    return await loadConnections(token);
  } catch (error) {
    if (error instanceof BetterStackResponseShapeError) {
      throw error;
    }

    return [];
  }
}

function validateQueryEndpointMatchesSource(
  normalizedUrl: string,
  sourceMetadata: BetterStackSourceMetadata,
  matchingConnection: BetterStackConnectionMetadata | null
): void {
  const endpoint = new URL(normalizedUrl);
  const endpointHost = endpoint.hostname;
  const endpointPort = getEffectiveUrlPort(endpoint);
  const expectedHost =
    matchingConnection?.host ?? `${sourceMetadata.dataRegion}-connect.betterstackdata.com`;
  const expectedPort = matchingConnection?.port ?? 443;
  const matchingRegionHost = `${sourceMetadata.dataRegion}-connect.betterstackdata.com`;

  if (
    (endpointHost === expectedHost && endpointPort === expectedPort) ||
    (endpointHost === matchingRegionHost && endpointPort === 443)
  ) {
    return;
  }

  const connectionContext = matchingConnection
    ? `Best matching connection host for ${sourceMetadata.teamName}/${sourceMetadata.sourceName} is ${matchingConnection.host}.`
    : `No connection was found for team ${sourceMetadata.teamName} in region ${sourceMetadata.dataRegion}.`;

  fail(
    `Query endpoint ${formatHostAndPort(endpointHost, endpointPort)} does not match source ${sourceMetadata.sourceId} (${sourceMetadata.teamName}/${sourceMetadata.sourceName}) in region ${sourceMetadata.dataRegion}. ${connectionContext}`
  );
}

function validateQueryEndpointIsAllowed(normalizedUrl: string): void {
  const endpoint = new URL(normalizedUrl);

  if (isAllowedBetterStackQueryHost(endpoint.hostname)) {
    return;
  }

  fail(
    `Query endpoint host ${endpoint.hostname} is not allowed. Expected a Better Stack query host ending in -connect.betterstackdata.com.`
  );
}

function isAllowedBetterStackQueryHost(hostname: string): boolean {
  return hostname.endsWith("-connect.betterstackdata.com");
}

function formatConnectionEndpoint(connection: BetterStackConnectionMetadata): string {
  if (/:\d+$/u.test(connection.host)) {
    return connection.host;
  }

  return `${connection.host}:${connection.port}`;
}

function getEffectiveUrlPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return 443;
}

function formatHostAndPort(host: string, port: number): string {
  return port === 443 ? host : `${host}:${port}`;
}

function isBetterStackSourceResponse(value: unknown): value is BetterStackSourceResponse {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }

  const {data} = value;
  const {attributes} = data;

  return (
    isRecord(attributes) &&
    typeof data.id === "string" &&
    typeof attributes.team_id === "number" &&
    typeof attributes.team_name === "string" &&
    typeof attributes.table_name === "string" &&
    typeof attributes.data_region === "string" &&
    typeof attributes.name === "string"
  );
}

function isBetterStackConnectionsResponse(value: unknown): value is BetterStackConnectionsResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return false;
  }

  return value.data.every((connection) => {
    if (!isRecord(connection) || !isRecord(connection.attributes)) {
      return false;
    }

    const {attributes} = connection;

    return (
      typeof attributes.data_region === "string" &&
      typeof attributes.host === "string" &&
      typeof attributes.port === "number" &&
      Array.isArray(attributes.team_ids) &&
      attributes.team_ids.every((teamId) => typeof teamId === "number") &&
      Array.isArray(attributes.team_names) &&
      attributes.team_names.every((teamName) => typeof teamName === "string") &&
      typeof attributes.username === "string"
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createMetadataClient(tokenOverride?: string): BetterStackClient {
  const token = tokenOverride ?? getFirstEnvValue(["BETTER_STACK_TOKEN", "BETTERSTACK_API_TOKEN"]);

  if (token === undefined || token === "") {
    fail(
      "Missing Better Stack API token. Provide --token or set BETTER_STACK_TOKEN or BETTERSTACK_API_TOKEN."
    );
  }

  return new BetterStackClient(token);
}

async function resolveSql(options: QueryRunOptions): Promise<string> {
  const inlineSql = options.sql;
  const {sqlFile} = options;
  const useStdin = options.stdin === true;
  const selectedInputs = [inlineSql !== undefined, sqlFile !== undefined, useStdin].filter(
    Boolean
  ).length;

  if (selectedInputs !== 1) {
    fail("Provide exactly one of --sql, --sql-file, or --stdin.");
  }

  if (inlineSql !== undefined) {
    return inlineSql;
  }

  if (sqlFile !== undefined) {
    return readFileSync(sqlFile, "utf-8");
  }

  if (process.stdin.isTTY) {
    fail("Expected SQL on stdin, but stdin is a TTY.");
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function fail(message: string): never {
  throw new Error(message);
}

function invalidResponse(message: string): never {
  throw new BetterStackResponseShapeError(message);
}

function writeStdout(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof BetterStackApiError) {
    process.stderr.write(`${error.status} ${error.statusText}\n`);

    if (error.body) {
      process.stderr.write(error.body.endsWith("\n") ? error.body : `${error.body}\n`);
    }

    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
