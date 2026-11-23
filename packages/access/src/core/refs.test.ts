/**
 * What/why: workspace ⇄ organization is a real cycle. Lazy resource thunks
 * must compose across separate ES modules without TDZ or duplicate entries.
 */
import { describe, expect, it } from "vitest";

import { compileAccess, resource } from "../index.js";
import { alpha } from "./test-support/cycle-alpha.access.js";
import { beta } from "./test-support/cycle-beta.access.js";

describe("access model composition", () => {
  it("discovers both sides of a cyclic graph from either entry", () => {
    expect(compileAccess([alpha]).definitions.map(({ entity }) => entity.wireName)).toEqual([
      "test/alpha",
      "test/beta",
    ]);
    expect(compileAccess([beta]).definitions.map(({ entity }) => entity.wireName)).toEqual(["test/beta", "test/alpha"]);
  });

  it("refuses two distinct definitions with the same wire name", () => {
    const duplicate = resource("test/alpha", {});
    expect(() => compileAccess([alpha, duplicate])).toThrow('duplicate DSL resource wireName "test/alpha"');
  });
});

describe("cross-entity permission tokens", () => {
  it("composes both sides of a genuine module cycle and resolves arrow targets", () => {
    const [sealedAlpha, sealedBeta] = compileAccess([alpha, beta]).definitions;
    if (sealedAlpha === undefined || sealedBeta === undefined) {
      throw new Error("cycle fixtures did not compose");
    }

    const alphaView = sealedAlpha.expressions["view"];
    const betaView = sealedBeta.expressions["view"];
    const alphaThrough = alphaView?.[0];
    const betaThrough = betaView?.[0];
    if (alphaThrough?.kind !== "through" || betaThrough?.kind !== "through") {
      throw new Error("cycle fixtures did not emit through terms");
    }

    expect(alphaThrough.target).toEqual(beta.permissions.view);
    expect(betaThrough.target).toEqual(alpha.permissions.view);
    expect(alpha.permissions.view.entityWireName).toBe("test/alpha");
    expect(beta.permissions.view.entityWireName).toBe("test/beta");
  });
});
