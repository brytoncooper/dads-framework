/** Internal: shared by StatusBadge, StatusLamp and ToneBar; not exported from the barrel. */
export type StatusTone = "positive" | "neutral" | "warning" | "critical" | "information";

export const STATUS_LAMP_CLASS: Record<StatusTone, string> = {
  positive: "bg-success",
  neutral: "bg-muted-foreground",
  warning: "bg-warning",
  critical: "bg-destructive",
  information: "bg-info",
};
