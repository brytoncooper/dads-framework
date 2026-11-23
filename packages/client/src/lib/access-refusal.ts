import { ACCESS_REFUSAL_VALUE } from "@dads-framework/core/contract";

/**
 * Whether an answer is the API's access edge refusing the caller: a 404 the
 * edge marked (`ACCESS_REFUSAL_HEADER`). Only the mark counts. An unmarked
 * 404 is a record a handler did not find, an unmarked 403 is some other rule
 * saying no, and a 401 is a session that ended.
 */
export function isAccessRefusal(
  status: number,
  refusalHeader: string | null,
): boolean {
  return status === 404 && refusalHeader === ACCESS_REFUSAL_VALUE;
}
