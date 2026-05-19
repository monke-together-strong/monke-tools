/** Format provider-neutral goal objective text for an agent prompt. */
export function formatGoalObjective(goalObjective: string): string {
  return `# Goal Objective

${goalObjective}`;
}
