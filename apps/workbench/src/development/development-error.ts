/** Stable local-development failures, with no credentials in diagnostics. */
export class WorkbenchDevelopmentError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "INVALID_STATE" | "ALREADY_RUNNING",
    message: string,
  ) {
    super(message);
    this.name = "WorkbenchDevelopmentError";
  }
}
