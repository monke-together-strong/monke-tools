interface QueryCredentials {
  password: string;
  url: string;
  username: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface BetterStackSourceResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      team_id: number;
      team_name: string;
      table_name: string;
      data_region: string;
      name: string;
    };
  };
}

export interface BetterStackConnectionsResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      id: number;
      client_type: string;
      note: string;
      host: string;
      port: number;
      username: string;
      data_region: string;
      team_ids: number[];
      team_names: string[];
    };
  }[];
}

export class BetterStackApiError extends Error {
  body: string;
  status: number;
  statusText: string;

  constructor(status: number, statusText: string, body: string) {
    super(`Better Stack API request failed with ${status} ${statusText}`);
    this.body = body;
    this.name = "BetterStackApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class BetterStackClient {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async getSource(id: number): Promise<string> {
    return await this.#requestJsonText(`https://telemetry.betterstack.com/api/v1/sources/${id}`);
  }

  async listSources(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/sources");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return await this.#requestJsonText(url.toString());
  }

  async listConnections(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/connections");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return await this.#requestJsonText(url.toString());
  }

  async runQuery(credentials: QueryCredentials, query: string): Promise<string> {
    const response = await fetch(credentials.url, {
      body: query,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        "Content-Type": "text/plain"
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return await this.#readTextResponse(response);
  }

  async #requestJsonText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.#token}`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    return await this.#readTextResponse(response);
  }

  async #readTextResponse(response: Response): Promise<string> {
    const body = await response.text();

    if (!response.ok) {
      throw new BetterStackApiError(response.status, response.statusText, body);
    }

    return body;
  }
}

export function normalizeQueryUrl(input: string): string {
  const schemeMatch = /^([a-z][a-z\d+.-]*):\/\//iu.exec(input);

  if (schemeMatch) {
    if (schemeMatch[1]?.toLowerCase() !== "https") {
      throw new Error("Better Stack query URL must use HTTPS.");
    }

    return input;
  }

  const separator = input.includes("?") ? "&" : "?";
  return `https://${input}${separator}output_format_pretty_row_numbers=0`;
}
