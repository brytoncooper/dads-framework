/**
 * What: a queued write that never answers is abandoned after its deadline —
 * its caller gets the error, the newest token is cleared, and the next queued
 * write still runs.
 * Why: writes run one at a time, so without a deadline one hung write (a
 * half-open connection, a stuck SpiceDB) would hold every later write forever.
 */

import { v1 } from "@authzed/authzed-node";
import { describe, expect, it } from "vitest";

import { relationshipWrite } from "@dads-framework/access/runtime";
import { SpiceDbAuthorization } from "./spice-db-authorization.js";

type SpiceDbClient = NonNullable<
  ConstructorParameters<typeof SpiceDbAuthorization>[1]
>;
type WriteResponse = Awaited<
  ReturnType<SpiceDbClient["promises"]["writeRelationships"]>
>;

const SUBJECT = { type: "user", id: "reader" };
const RESOURCE = { type: "test/document", id: "document" };
const GRANT = relationshipWrite(RESOURCE, "viewer", SUBJECT);
const FULLY_CONSISTENT = {
  requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
};

describe("SpiceDB write deadline", () => {
  it("abandons a write that never answers, clears the token, and runs the next write", async () => {
    let answerQueued: () => void = () => undefined;
    let queuedSent = false;
    const answers: (() => Promise<WriteResponse>)[] = [
      () =>
        Promise.resolve(
          v1.WriteRelationshipsResponse.create({
            writtenAt: { token: "before" },
          }),
        ),
      () => new Promise<WriteResponse>(() => undefined),
      () => {
        queuedSent = true;
        return new Promise<WriteResponse>((resolve) => {
          answerQueued = () => {
            resolve(
              v1.WriteRelationshipsResponse.create({
                writtenAt: { token: "after" },
              }),
            );
          };
        });
      },
    ];
    const reads: unknown[] = [];
    const unavailable = (): never => {
      throw new Error("Unexpected call in write deadline proof");
    };
    const client: SpiceDbClient = {
      promises: {
        checkPermission: (request) => {
          reads.push(request.consistency);
          return Promise.resolve({ permissionship: 2 });
        },
        lookupResources: unavailable,
        readRelationships: unavailable,
        writeRelationships: () => {
          const answer = answers.shift();
          if (answer === undefined) throw new Error("Unexpected write");
          return answer();
        },
        deleteRelationships: unavailable,
        readSchema: unavailable,
        writeSchema: unavailable,
      },
    };
    const authorization = new SpiceDbAuthorization(
      {
        endpoint: "localhost:50051",
        presharedKey: "test",
        insecure: true,
        relationshipWriteDeadlineMs: 20,
      },
      client,
    );
    const check = () =>
      authorization.check({
        subject: SUBJECT,
        resource: RESOURCE,
        permission: "view",
      });

    await expect(authorization.writeRelationships([GRANT])).resolves.toBe(
      "before",
    );
    const hung = authorization.writeRelationships([GRANT]);
    const queued = authorization.writeRelationships([GRANT]);
    expect(queuedSent).toBe(false);
    await expect(hung).rejects.toThrow(/no answer within/);
    await check();
    expect(reads).toEqual([FULLY_CONSISTENT]);

    // The queue moved on: the next write was sent once the hung one gave up.
    await new Promise((resolve) => setImmediate(resolve));
    expect(queuedSent).toBe(true);
    answerQueued();
    await expect(queued).resolves.toBe("after");
    await check();
    expect(reads.at(-1)).toEqual({
      requirement: {
        oneofKind: "atLeastAsFresh",
        atLeastAsFresh: { token: "after" },
      },
    });
  });
});
