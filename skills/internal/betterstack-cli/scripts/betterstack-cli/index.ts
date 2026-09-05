#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import type { OptionValues } from "@commander-js/extra-typings";
import type { ZodType } from "zod";

import {
  BetterStackApiError,
  BetterStackClient,
  BetterStackConnectionsResponseSchema,
  BetterStackSourceResponseSchema,
  normalizeQueryUrl
} from "./client";
import { getFirstEnvValue, loadEnvFileIfPresent } from "./env";

async function main() {
  const program = createProgram();
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

function createProgram() {
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
    handleConnectionList
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
      .option("--per-page <number>", "Results per page.", parseIntegerOption)
  );
}

function createSourceGetCommand(parent: Command) {
  return addCredentialOptions(
    parent
      .command("get")
      .description("Fetch one Better Stack source.")
      .requiredOption("--id <number>", "Better Stack source id.", parseIntegerOption)
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
    "Better Stack source API token for metadata validation."
  );
}

function addCredentialOptions<
  Args extends unknown[],
  Options extends OptionValues,
  GlobalOptions extends OptionValues
>(
  command: Command<Args, Options, GlobalOptions>,
  tokenDescription = "Better Stack source API token."
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

function parseIntegerOption(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("must be an integer.");
  }

  return parsed;
}

function initializeEnvironment(envFilePath?: string) {
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

async function handleSourceList(options: PaginationOptions) {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const { page } = options;
  const { perPage } = options;

  writeStdout(await client.listSources(page, perPage));
}

async function handleSourceGet(options: SourceGetOptions) {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const { id } = options;

  writeStdout(await client.getSource(id));
}

async function handleConnectionList(options: PaginationOptions) {
  initializeEnvironment(options.envFile);

  const client = createMetadataClient(options.token);
  const { page } = options;
  const { perPage } = options;

  writeStdout(await client.listConnections(page, perPage));
}

async function handleQueryRun(options: QueryRunOptions) {
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
  host: string;
  port: number;
  teamIds: number[];
  teamNames: string[];
  username: string;
}

class BetterStackCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetterStackCliError";
  }
}

class BetterStackInvalidResponseError extends BetterStackCliError {
  constructor(message: string) {
    super(message);
    this.name = "BetterStackInvalidResponseError";
  }
}

async function resolveQueryCredentials(options: QueryRunOptions, context: ResolvedQueryContext) {
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

async function loadQueryMetadata(context: ResolvedQueryContext) {
  if (context.metadataToken === undefined || context.metadataToken === "") {
    return { matchingConnection: null, sourceMetadata: null };
  }

  const sourceMetadata = await tryLoadSourceMetadata(context.metadataToken, context.sourceId);
  if (sourceMetadata === null) {
    return { matchingConnection: null, sourceMetadata };
  }
  const connections = await tryLoadConnections(context.metadataToken);
  const regionHost = queryHostForRegion(sourceMetadata.dataRegion);
  const matchingConnection =
    connections.find(
      (connection) =>
        connection.host === regionHost && connection.teamIds.includes(sourceMetadata.teamId)
    ) ?? null;
  return { matchingConnection, sourceMetadata };
}

function validateQueryTable(
  context: ResolvedQueryContext,
  sourceMetadata: BetterStackSourceMetadata | null
) {
  if (sourceMetadata !== null && context.table !== sourceMetadata.expectedTable) {
    fail(
      `Table mismatch for source ${sourceMetadata.sourceId}. Expected ${sourceMetadata.expectedTable}, received ${context.table}.`
    );
  }
}

function requireQueryCredential(value: string | undefined, message: string) {
  if (value === undefined || value === "") {
    fail(message);
  }
  return value;
}

async function loadSourceMetadata(token: string, sourceId: number) {
  const client = createMetadataClient(token);
  const raw = await client.getSource(sourceId);
  const parsed = parseMetadataResponse(
    raw,
    BetterStackSourceResponseSchema,
    "Invalid Better Stack source response: expected data.attributes."
  );

  return {
    dataRegion: parsed.data.attributes.data_region,
    expectedTable: `t${parsed.data.attributes.team_id}.${parsed.data.attributes.table_name}`,
    sourceId: parsed.data.id,
    sourceName: parsed.data.attributes.name,
    teamId: parsed.data.attributes.team_id,
    teamName: parsed.data.attributes.team_name
  };
}

async function loadConnections(token: string) {
  const client = createMetadataClient(token);
  const raw = await client.listConnections(1, 100);
  const parsed = parseMetadataResponse(
    raw,
    BetterStackConnectionsResponseSchema,
    "Invalid Better Stack connections response: expected data[].attributes."
  );

  return parsed.data.map((connection) => ({
    host: connection.attributes.host,
    port: connection.attributes.port,
    teamIds: connection.attributes.team_ids,
    teamNames: connection.attributes.team_names,
    username: connection.attributes.username
  }));
}

async function tryLoadSourceMetadata(token: string, sourceId: number) {
  try {
    return await loadSourceMetadata(token, sourceId);
  } catch (error) {
    if (error instanceof BetterStackInvalidResponseError) {
      throw error;
    }

    return null;
  }
}

async function tryLoadConnections(token: string) {
  try {
    return await loadConnections(token);
  } catch (error) {
    if (error instanceof BetterStackInvalidResponseError) {
      throw error;
    }

    return [];
  }
}

function validateQueryEndpointMatchesSource(
  normalizedUrl: string,
  sourceMetadata: BetterStackSourceMetadata,
  matchingConnection: BetterStackConnectionMetadata | null
) {
  const endpoint = new URL(normalizedUrl);
  const endpointHost = endpoint.hostname;
  const endpointPort = getEffectiveUrlPort(endpoint);
  const matchingRegionHost = queryHostForRegion(sourceMetadata.dataRegion);
  const expectedHost = matchingConnection?.host ?? matchingRegionHost;
  const expectedPort = matchingConnection?.port ?? 443;

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

function validateQueryEndpointIsAllowed(normalizedUrl: string) {
  const endpoint = new URL(normalizedUrl);

  if (isAllowedBetterStackQueryHost(endpoint.hostname)) {
    return;
  }

  fail(
    `Query endpoint host ${endpoint.hostname} is not allowed. Expected a Better Stack query host ending in ${QUERY_HOST_SUFFIX}.`
  );
}

const QUERY_HOST_SUFFIX = "-connect.betterstackdata.com";

function queryHostForRegion(region: string) {
  return `${region}${QUERY_HOST_SUFFIX}`;
}

function isAllowedBetterStackQueryHost(hostname: string) {
  return hostname.endsWith(QUERY_HOST_SUFFIX);
}

function formatConnectionEndpoint(connection: BetterStackConnectionMetadata) {
  if (/:\d+$/u.test(connection.host)) {
    return connection.host;
  }

  return `${connection.host}:${connection.port}`;
}

function getEffectiveUrlPort(url: URL) {
  if (url.port) {
    return Number(url.port);
  }

  return 443;
}

function formatHostAndPort(host: string, port: number) {
  return port === 443 ? host : `${host}:${port}`;
}

function parseMetadataResponse<T extends ZodType>(raw: string, schema: T, errorMessage: string) {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // The shared contract error below covers malformed JSON and invalid payloads.
  }
  return invalidResponse(errorMessage);
}

function createMetadataClient(tokenOverride?: string) {
  const token = tokenOverride ?? getFirstEnvValue(["BETTER_STACK_TOKEN", "BETTERSTACK_API_TOKEN"]);

  if (token === undefined || token === "") {
    fail(
      "Missing Better Stack API token. Provide --token or set BETTER_STACK_TOKEN or BETTERSTACK_API_TOKEN."
    );
  }

  return new BetterStackClient(token);
}

async function resolveSql(options: QueryRunOptions) {
  const inlineSql = options.sql;
  const { sqlFile } = options;
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
  throw new BetterStackCliError(message);
}

function invalidResponse(message: string): never {
  throw new BetterStackInvalidResponseError(message);
}

function writeStdout(text: string) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function reportFailure(cause: unknown) {
  if (cause instanceof BetterStackApiError) {
    process.stderr.write(`${cause.status} ${cause.statusText}\n`);

    if (cause.body) {
      process.stderr.write(cause.body.endsWith("\n") ? cause.body : `${cause.body}\n`);
    }

    process.exitCode = 1;
    return;
  }

  const message =
    cause instanceof BetterStackCliError
      ? cause.message
      : cause instanceof Error
        ? (cause.stack ?? `${cause.name}: ${cause.message}`)
        : String(cause);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  reportFailure(error);
}
