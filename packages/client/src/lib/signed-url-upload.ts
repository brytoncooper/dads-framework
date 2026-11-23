/**
 * Sends bytes to a storage URL the API signed for one upload. The URL is the
 * bucket's, not the API's: no session, locale or context headers go with it,
 * only the headers it was signed with, sent unchanged. Any non-2xx answer
 * means storage refused the bytes.
 */
export async function putToSignedUrl(input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob | ArrayBuffer;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(input.url, {
    method: "PUT",
    headers: input.headers,
    body: input.body,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new SignedUploadRefusedError(response.status);
}

/** Storage answered the signed PUT with a non-2xx status. */
export class SignedUploadRefusedError extends Error {
  constructor(readonly status: number) {
    super(`Storage refused the signed upload (${status.toString()})`);
    this.name = "SignedUploadRefusedError";
  }
}
