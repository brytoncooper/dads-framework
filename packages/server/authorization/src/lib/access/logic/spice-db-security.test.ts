/**
 * Locks credential-bearing SpiceDB transport selection: Docker and workspace
 * hostnames must not be mistaken for localhost merely because TLS is disabled.
 */
import { describe, expect, it } from "vitest";
import { resolveSpiceDbSecurityMode } from "./spice-db-security.js";

describe("resolveSpiceDbSecurityMode", () => {
  it("uses secure transport when plaintext is disabled", () => {
    expect(resolveSpiceDbSecurityMode("spicedb.example:443", false)).toBe(
      "secure",
    );
  });

  it("uses the localhost-only mode for loopback hostnames", () => {
    expect(resolveSpiceDbSecurityMode("localhost:50051", true)).toBe(
      "insecure-localhost",
    );
  });

  it.each(["spicedb:50051", "host.docker.internal:50051", "10.0.0.8:50051"])(
    "keeps credentials on a non-localhost plaintext endpoint: %s",
    (endpoint) => {
      expect(resolveSpiceDbSecurityMode(endpoint, true)).toBe(
        "insecure-plaintext",
      );
    },
  );
});
