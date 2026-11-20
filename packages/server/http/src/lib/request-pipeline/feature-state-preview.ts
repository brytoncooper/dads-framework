/**
 * A feature preview: one caller forcing one feature on or off for their own
 * requests, without changing anybody's saved audience.
 *
 * The kit owns the once-per-request protocol — read the preview id header,
 * ask the application whether it names a live preview for this caller, refuse
 * a write the preview does not allow, and carry the preview for the rest of
 * the request so every evaluation inside it (the snapshot, capability guards,
 * a handler's own flag check) sees the same answer. What a preview id means,
 * who may hold one and which features exist are the application's.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { SubjectRef } from "@dads-framework/access/runtime";
import { forbidden } from "@dads-framework/errors";

import { isWriteMethod } from "./logic/is-write-method.js";

/** A live preview, as the application resolved it for this request. */
export type FeatureStatePreview = {
  /** The one feature this preview forces. */
  readonly feature: string;
  /** Whether that feature reads as on while the preview applies. */
  readonly active: boolean;
  /** Whether writes run while this preview applies; false refuses them. */
  readonly allowsWrites: boolean;
};

/** Application-bound resolver. Null means the id names no live preview for this caller. */
export type FeatureStatePreviewResolver = {
  resolve(input: {
    readonly previewId: string;
    readonly authenticatedSubject: SubjectRef;
  }): Promise<FeatureStatePreview | null>;
};

/** The application's half of the preview protocol: who resolves an id, and the header names its clients speak. */
export type FeatureStatePreviewProtocol = {
  readonly resolver: FeatureStatePreviewResolver;
  /** Request header carrying the caller's preview id. */
  readonly requestHeader: string;
  /** Response header written when the supplied id names no live preview, so the client forgets it. */
  readonly droppedHeader: string;
};

const previewContext = new AsyncLocalStorage<FeatureStatePreview>();

/**
 * The preview the current request carries, or `undefined` outside a request or
 * when it carries none. Evaluators call this, so a capability guard deep in a
 * handler answers the same as the request's own snapshot.
 */
export function currentFeatureStatePreview(): FeatureStatePreview | undefined {
  return previewContext.getStore();
}

/** Runs `work` with `preview` as the current preview, for this pipeline and for tests. */
export function runWithFeatureStatePreview<T>(
  preview: FeatureStatePreview,
  work: () => Promise<T>,
): Promise<T> {
  return previewContext.run(preview, work);
}

type PreviewRequest = {
  readonly headers: Record<string, string | string[] | undefined>;
};

/**
 * Resolves the request's preview id once, refuses a write the preview does not
 * allow, and runs `work` inside the preview.
 *
 * An id that resolves to nothing never fails the request: it is answered as
 * if no preview were sent, with `droppedHeader` telling the client to forget
 * it. A request with no authenticated caller cannot hold a preview, so its id
 * is ignored without a verdict.
 */
export async function carryFeatureStatePreview<T>(input: {
  readonly protocol: FeatureStatePreviewProtocol | undefined;
  readonly request: PreviewRequest;
  readonly reply: { header(name: string, value: string): unknown };
  readonly authenticatedSubject: SubjectRef | null;
  readonly method: string;
  readonly writesDuringFeaturePreview: "allowed" | undefined;
  readonly work: () => Promise<T>;
}): Promise<T> {
  const { protocol } = input;
  if (protocol === undefined || input.authenticatedSubject === null) {
    return input.work();
  }
  const previewId = input.request.headers[protocol.requestHeader];
  if (typeof previewId !== "string" || previewId.length === 0) {
    return input.work();
  }
  const preview = await protocol.resolver.resolve({
    previewId,
    authenticatedSubject: input.authenticatedSubject,
  });
  if (preview === null) {
    void input.reply.header(protocol.droppedHeader, "1");
    return input.work();
  }
  if (
    !preview.allowsWrites &&
    isWriteMethod(input.method) &&
    input.writesDuringFeaturePreview !== "allowed"
  ) {
    throw forbidden(
      "FEATURE_PREVIEW_READ_ONLY",
      "Saving is turned off while previewing",
    );
  }
  return runWithFeatureStatePreview(preview, input.work);
}
