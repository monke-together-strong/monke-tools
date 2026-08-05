export class BetterStackApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    super(`Better Stack API request failed with ${status} ${statusText}`);
    this.name = "BetterStackApiError";
  }
}
