import { describe, expect, it } from "vitest";

import type { AuditActor } from "@dads-framework/core/audit-actor";
import type { SubjectRef } from "@dads-framework/spicedb-access";

import { composeSubjectToAuditActor, type ResolvedSubject } from "./compose-subject-to-audit-actor.js";

const REQUEST_ID = "01990000-0000-7000-8000-000000000001";
const USER: SubjectRef = { type: "user", id: "user-1" };

/** Stands in for a product's own subject kind; the kit knows no wire names. */
const PRODUCT_SUBJECT_TYPE = "product/robot";

function robotActor({ subject, requestId }: ResolvedSubject): AuditActor {
  return { kind: "device", id: subject.id, requestId };
}

const subjectToAuditActor = composeSubjectToAuditActor({
  [PRODUCT_SUBJECT_TYPE]: robotActor,
});

const cases: readonly {
  readonly kind: string;
  readonly subject: SubjectRef | null;
  readonly authenticatedSubject: SubjectRef | null;
  readonly expected: AuditActor;
}[] = [
  {
    kind: "anonymous",
    subject: null,
    authenticatedSubject: null,
    expected: { kind: "anonymous", id: "", requestId: REQUEST_ID },
  },
  {
    kind: "user",
    subject: USER,
    authenticatedSubject: USER,
    expected: { kind: "user", id: "user-1", requestId: REQUEST_ID },
  },
  {
    kind: "a composed subject type",
    subject: { type: PRODUCT_SUBJECT_TYPE, id: "robot-1" },
    authenticatedSubject: { type: PRODUCT_SUBJECT_TYPE, id: "robot-1" },
    expected: { kind: "device", id: "robot-1", requestId: REQUEST_ID },
  },
];

describe("composeSubjectToAuditActor", () => {
  it.each(cases)("maps $kind", ({ subject, authenticatedSubject, expected }) => {
    expect(
      subjectToAuditActor({
        subject,
        authenticatedSubject,
        requestId: REQUEST_ID,
      }),
    ).toEqual(expected);
  });

  it("falls back to the proven identity for a subject type it does not know", () => {
    expect(
      subjectToAuditActor({
        subject: { type: "platform/some_future_actor", id: "future-1" },
        authenticatedSubject: USER,
        requestId: REQUEST_ID,
      }),
    ).toEqual({ kind: "user", id: "user-1", requestId: REQUEST_ID });
  });

  it("falls back to anonymous when nothing proved an identity", () => {
    expect(
      subjectToAuditActor({
        subject: { type: "platform/some_future_actor", id: "future-1" },
        authenticatedSubject: null,
        requestId: REQUEST_ID,
      }),
    ).toEqual({ kind: "anonymous", id: "", requestId: REQUEST_ID });
  });

  it("attributes a request to the proven identity when the two users disagree", () => {
    expect(
      subjectToAuditActor({
        subject: { type: "user", id: "user-2" },
        authenticatedSubject: USER,
        requestId: REQUEST_ID,
      }),
    ).toEqual({ kind: "user", id: "user-1", requestId: REQUEST_ID });
  });

  it("keeps its own user mapping when a product supplies one for that type", () => {
    const withOverriddenUser = composeSubjectToAuditActor({
      user: ({ subject, requestId }) => ({
        kind: "device",
        id: subject.id,
        requestId,
      }),
    });
    expect(
      withOverriddenUser({
        subject: USER,
        authenticatedSubject: USER,
        requestId: REQUEST_ID,
      }),
    ).toEqual({ kind: "user", id: "user-1", requestId: REQUEST_ID });
  });
});

describe("application request attribution", () => {
  const request = {
    subject: USER,
    authenticatedSubject: USER,
    requestId: REQUEST_ID,
  };

  it("uses the application actor when supplied for a request", () => {
    const actor: AuditActor = {
      kind: "application_operator",
      id: "operator-1",
      requestId: REQUEST_ID,
    };
    const mapActor = composeSubjectToAuditActor({}, () => actor);
    expect(mapActor(request)).toEqual(actor);
  });
});
