export function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Supplies the storage error name recognized by multipart consumers. */
export function multipartError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
