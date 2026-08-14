import { BetterStackApiError } from "./api-error";
import * as z from "zod";

interface QueryCredentials {
  password: string;
  url: string;
  username: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export { BetterStackApiError } from "./api-error";

export const BetterStackSourceResponseSchema = z.object({
  data: z.object({
    attributes: z.object({
      data_region: z.string(),
      name: z.string(),
      table_name: z.string(),
      team_id: z.number(),
      team_name: z.string()
    }),
    id: z.string()
  })
});

export type BetterStackSourceResponse = z.output<typeof BetterStackSourceResponseSchema>;

export const BetterStackConnectionsResponseSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        data_region: z.string(),
        host: z.string(),
        port: z.number(),
        team_ids: z.array(z.number()),
        team_names: z.array(z.string()),
        username: z.string()
      })
    })
  )
});

export type BetterStackConnectionsResponse = z.output<
  typeof BetterStackConnectionsResponseSchema
>;

export class BetterStackClient {
  constructor(private readonly token: string) {}

  getSource(id: number): Promise<string> {
    return this.#requestJsonText(`https://telemetry.betterstack.com/api/v1/sources/${id}`);
  }

  listSources(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/sources");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  listConnections(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/connections");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  static async runQuery(credentials: QueryCredentials, query: string): Promise<string> {
    const response = await fetch(credentials.url, {
      body: query,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        "Content-Type": "text/plain"
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return await readTextResponse(response);
  }

  async #requestJsonText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return await readTextResponse(response);
  }
}

export function normalizeQueryUrl(input: string): string {
  const schemeMatch = /^(?<scheme>[a-z][a-z\d+.-]*):\/\//iu.exec(input);

  if (schemeMatch) {
    if (schemeMatch.groups?.scheme?.toLowerCase() !== "https") {
      throw new Error("Better Stack query URL must use HTTPS.");
    }

    return input;
  }

  const separator = input.includes("?") ? "&" : "?";
  return `https://${input}${separator}output_format_pretty_row_numbers=0`;
}

async function readTextResponse(response: Response): Promise<string> {
  const body = await response.text();

  if (!response.ok) {
    throw new BetterStackApiError(response.status, response.statusText, body);
  }

  return body;
}
