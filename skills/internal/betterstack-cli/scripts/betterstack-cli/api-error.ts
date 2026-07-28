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
