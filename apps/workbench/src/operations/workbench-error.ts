export class WorkbenchError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "RELATIONSHIPS_PENDING" | "AUTHORIZATION_UNAVAILABLE",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "WorkbenchError";
  }
}
