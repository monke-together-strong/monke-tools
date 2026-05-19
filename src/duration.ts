/** Convert elapsed milliseconds into compact human-readable text. */
const durationFormatter = new Intl.DurationFormat("en", { style: "narrow" });

export function formatDuration(durationMs: number): string {
  const safeDurationMs = Math.max(0, Math.round(durationMs));
  if (safeDurationMs < 1000) {
    return durationFormatter.format({ milliseconds: safeDurationMs });
  }

  const totalSeconds = Math.round(safeDurationMs / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  return durationFormatter.format({
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    seconds: totalSeconds % 60,
  });
}
