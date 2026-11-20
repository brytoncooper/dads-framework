export type JournalStampDecision = "skip" | "stamp-if-equivalent";

export function journalStampDecision(input: {
  appliedCount: number;
  publicTableCount: number;
}): JournalStampDecision {
  if (input.appliedCount > 0) {
    return "skip";
  }
  if (input.publicTableCount === 0) {
    return "skip";
  }
  return "stamp-if-equivalent";
}
