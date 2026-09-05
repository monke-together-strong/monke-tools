import { array, number, object, string } from "zod";

import { BetterStackApiError } from "./api-error";

interface QueryCredentials {
  password: string;
  url: string;
  username: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export { BetterStackApiError } from "./api-error";

export const BetterStackSourceResponseSchema = object({
  data: object({
    attributes: object({
      data_region: string(),
      name: string(),
      table_name: string(),
      team_id: number(),
      team_name: string()
    }),
    id: string()
  })
});

export const BetterStackConnectionsResponseSchema = object({
  data: array(
    object({
      attributes: object({
        host: string(),
        port: number(),
        team_ids: array(number()),
        team_names: array(string()),
        username: string()
      })
    })
  )
});

export class BetterStackClient {
  constructor(private readonly token: string) {}

  getSource(id: number) {
    return this.#requestJsonText(`https://telemetry.betterstack.com/api/v1/sources/${id}`);
  }

  listSources(page?: number, perPage?: number) {
    const url = new URL("https://telemetry.betterstack.com/api/v1/sources");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  listConnections(page?: number, perPage?: number) {
    const url = new URL("https://telemetry.betterstack.com/api/v1/connections");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  static async runQuery(credentials: QueryCredentials, query: string) {
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

  async #requestJsonText(url: string) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return await readTextResponse(response);
  }
}

export function normalizeQueryUrl(input: string) {
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

async function readTextResponse(response: Response) {
  const body = await response.text();

  if (!response.ok) {
    throw new BetterStackApiError(response.status, response.statusText, body);
  }

  return body;
}
