/** SpiceDB's refusal to read a schema that was never written. */
export function isEmptySchemaError(error: unknown): boolean {
  return /no schema has been defined|schema has not been defined|no schema has been written|object definitions have not been written|schema is empty/i.test(
    errorMessage(error),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}
