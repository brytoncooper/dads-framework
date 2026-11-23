import { describe, expect, it } from "vitest";
import {
  authorizationSchemaFingerprint,
  canonicalAuthorizationSchema,
} from "../../definition-changes.mjs";

function schema(expression: string): string {
  return `definition user {}
definition test/group {
  relation member: user
  permission view = member
}
definition test/document {
  relation owner: test/group
  relation actor: user
  relation worker: user
  permission view = ${expression}
}`;
}

describe("SpiceDB schema grouping normalization", () => {
  it("compares generated atom and union grouping with SpiceDB's equivalent read form", () => {
    const authored = schema("((owner->view) & (actor + worker))");
    const observed = schema("(owner->view & actor + worker)");
    expect(authorizationSchemaFingerprint(authored)).toBe(
      authorizationSchemaFingerprint(observed),
    );
  });

  it("normalizes redundant outer and singleton parentheses without removing arrow-call syntax", () => {
    const authored = schema("(((owner.all(view))))");
    const observed = schema("owner.all(view)");
    expect(canonicalAuthorizationSchema(authored)).toBe(
      canonicalAuthorizationSchema(observed),
    );
  });

  it("normalizes nested associative intersections while retaining the union inside them", () => {
    const authored = schema(
      "owner->view + ((actor) & (((actor + worker) & (worker))))",
    );
    const observed = schema("owner->view + (actor & actor + worker & worker)");
    expect(authorizationSchemaFingerprint(authored)).toBe(
      authorizationSchemaFingerprint(observed),
    );
  });

  it("normalizes the any arrow alias while preserving the distinct all arrow", () => {
    expect(authorizationSchemaFingerprint(schema("owner.any(view)"))).toBe(
      authorizationSchemaFingerprint(schema("owner->view")),
    );
    expect(authorizationSchemaFingerprint(schema("owner.all(view)"))).not.toBe(
      authorizationSchemaFingerprint(schema("owner->view")),
    );
  });

  it("preserves intersection grouping that changes access", () => {
    expect(
      authorizationSchemaFingerprint(schema("actor + (worker & owner->view)")),
    ).not.toBe(
      authorizationSchemaFingerprint(schema("(actor + worker) & owner->view")),
    );
  });

  it("preserves exclusion grouping and operand order", () => {
    expect(
      authorizationSchemaFingerprint(schema("actor - (worker - owner->view)")),
    ).not.toBe(
      authorizationSchemaFingerprint(schema("(actor - worker) - owner->view")),
    );
    expect(authorizationSchemaFingerprint(schema("actor - worker"))).not.toBe(
      authorizationSchemaFingerprint(schema("worker - actor")),
    );
  });

  it("preserves relation, permission and definition drift", () => {
    const original = schema("actor + worker");
    expect(
      authorizationSchemaFingerprint(
        original.replace("relation actor: user", "relation actor: test/group"),
      ),
    ).not.toBe(authorizationSchemaFingerprint(original));
    expect(authorizationSchemaFingerprint(schema("actor & worker"))).not.toBe(
      authorizationSchemaFingerprint(original),
    );
    expect(
      authorizationSchemaFingerprint(
        `${original}\ndefinition test/unrecorded {}`,
      ),
    ).not.toBe(authorizationSchemaFingerprint(original));
  });
});
