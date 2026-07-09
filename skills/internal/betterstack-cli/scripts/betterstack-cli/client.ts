type QueryCredentials = {
  password: string;
  url: string;
  username: string;
};

export type BetterStackSourceResponse = {
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
};

export type BetterStackConnectionsResponse = {
  data: Array<{
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
  }>;
};

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
  #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async getSource(id: number): Promise<string> {
    return this.#requestJsonText(`https://telemetry.betterstack.com/api/v1/sources/${id}`);
  }

  async listSources(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/sources");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  async listConnections(page?: number, perPage?: number): Promise<string> {
    const url = new URL("https://telemetry.betterstack.com/api/v1/connections");

    if (page !== undefined) {
      url.searchParams.set("page", String(page));
    }

    if (perPage !== undefined) {
      url.searchParams.set("per_page", String(perPage));
    }

    return this.#requestJsonText(url.toString());
  }

  async runQuery(credentials: QueryCredentials, query: string): Promise<string> {
    const response = await fetch(credentials.url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        "Content-Type": "text/plain"
      },
      body: query
    });

    return this.#readTextResponse(response);
  }

  async #requestJsonText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.#token}`
      }
    });

    return this.#readTextResponse(response);
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
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  return `https://${input}?output_format_pretty_row_numbers=0`;
}
