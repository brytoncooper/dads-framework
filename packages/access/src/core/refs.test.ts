/**
 * What/why: workspace ⇄ organization is a real cycle. Permission tokens must
 * resolve after both access modules load, without strings or thunks.
 */
import { describe, expect, it } from "vitest";
import { alpha } from "./test-support/cycle-alpha.access.js";
import { beta } from "./test-support/cycle-beta.access.js";
import { accessModel } from "./access-model.js";

describe("access model composition", () => {
  it("keeps independently composed definitions separate", () => {
    expect(
      accessModel([alpha]).definitions.map(({ entity }) => entity.wireName),
    ).toEqual(["test/alpha"]);
    expect(
      accessModel([beta]).definitions.map(({ entity }) => entity.wireName),
    ).toEqual(["test/beta"]);
  });

  it("refuses two definitions with the same entity name", () => {
    expect(() => accessModel([alpha, alpha])).toThrow(
      "duplicate access model entry test/alpha",
    );
  });
});

describe("cross-entity permission tokens", () => {
  it("composes both sides of a genuine module cycle and resolves through() targets", () => {
    const [sealedAlpha, sealedBeta] = accessModel([alpha, beta]).definitions;
    if (sealedAlpha === undefined || sealedBeta === undefined) {
      throw new Error("cycle fixtures did not compose");
    }

    const alphaView = sealedAlpha.expressions["view"];
    const betaView = sealedBeta.expressions["view"];
    const alphaThrough = alphaView?.[0];
    const betaThrough = betaView?.[0];
    if (alphaThrough?.kind !== "through" || betaThrough?.kind !== "through") {
      throw new Error("cycle fixtures did not emit through() terms");
    }

    expect(alphaThrough.target).toEqual(beta.permissions.view);
    expect(betaThrough.target).toEqual(alpha.permissions.view);
    expect(alpha.permissions.view.entityWireName).toBe("test/alpha");
    expect(beta.permissions.view.entityWireName).toBe("test/beta");
  });
});
