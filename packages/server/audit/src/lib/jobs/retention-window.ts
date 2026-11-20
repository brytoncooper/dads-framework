const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export function requirePositiveIntegerRetentionDays(
  retentionDays: number,
): void {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(
      `retentionDays must be a positive integer, got ${retentionDays}`,
    );
  }
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MILLISECONDS_PER_DAY);
}
