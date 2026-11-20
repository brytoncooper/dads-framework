import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { parseAuthorizationIds } from "../authorization-ids.js";
import { entityIdSchema } from "../entity-id.js";

const alphaIdSchema = entityIdSchema("AlphaId", "An alpha id");
type AlphaId = z.infer<typeof alphaIdSchema>;

const betaIdSchema = entityIdSchema("BetaId", "A beta id");

const V7 = "0192f2a0-0000-7000-8000-000000000000";
const V4 = "550e8400-e29b-41d4-a716-446655440000";

describe("parseAuthorizationIds", () => {
  it("turns an authorization answer into a branded set", () => {
    const visible = parseAuthorizationIds(alphaIdSchema, [V7]);
    expectTypeOf(visible).toEqualTypeOf<readonly AlphaId[]>();
    expect(visible).toEqual([V7]);
  });

  it("keeps the brand of the schema it was given", () => {
    const betaIds = parseAuthorizationIds(betaIdSchema, [V7]);
    expectTypeOf(betaIds).not.toExtend<readonly AlphaId[]>();
    expect(betaIds).toEqual([V7]);
  });

  it("refuses an id the authorization layer should never have returned", () => {
    expect(() => parseAuthorizationIds(alphaIdSchema, [V4])).toThrow();
  });

  it("passes an empty visible set through — fail-closed stays fail-closed", () => {
    expect(parseAuthorizationIds(alphaIdSchema, [])).toEqual([]);
  });
});
