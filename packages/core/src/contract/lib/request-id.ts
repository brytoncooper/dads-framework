/**
 * Correlation header services reads, echoes, and logs
 * (observability.md#correlation-request-ids). Clients send it to correlate
 * retries; the error envelope's `requestId` is this header's value.
 */
export const REQUEST_ID_HEADER = "x-request-id";
