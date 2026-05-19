/** Convert elapsed milliseconds into compact human-readable text. */
export function formatDuration(durationMs: number): string {
  const safeDurationMs = Math.max(0, Math.round(durationMs));
  if (safeDurationMs < 1000) {
    return `${safeDurationMs}ms`;
  }

  const totalSeconds = Math.round(safeDurationMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}
