/** `last_error` is an operator's first read, not a transcript. */
export const MAX_DELIVERY_ERROR_SUMMARY_LENGTH = 500;

/**
 * What went wrong, in one line an operator can act on and a log can hold.
 *
 * A thrown value that is not an `Error` is named by its type and nothing
 * else. Stringifying it is exactly how a rendered body or a recipient ends up
 * in the column and then in the logs (INV-EMAILDELIVERY-4), and an object
 * nobody threw deliberately has no message worth reading anyway.
 */
export function summarizeDeliveryError(error: unknown): string {
  return `${deliveryErrorName(error)}: ${deliveryErrorDetail(error)}`.slice(
    0,
    MAX_DELIVERY_ERROR_SUMMARY_LENGTH,
  );
}

/**
 * The error's class alone — what a log event carries. A message can quote a
 * vendor's response, which can quote the message that was sent, so the logs
 * get the name and the row gets the summary.
 */
export function deliveryErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function deliveryErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : typeof error;
}
