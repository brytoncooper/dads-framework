import { it } from "vitest";
import { inMemoryIdentity, inMemoryIdentityCookie, verifyIdentitySessionConformance } from "./index.js";

it("observes the shared session laws with seeded accounts and a fixed clock", async () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const account = {
    id: "fixture",
    email: "fixture@example.test",
    emailVerified: true,
  };
  const expiresAt = new Date("2026-11-20T13:00:00Z");
  await verifyIdentitySessionConformance({
    identity: inMemoryIdentity(
      {
        active: { account, expiresAt },
        other: { account, expiresAt },
        expired: { account, expiresAt: now },
      },
      () => now,
    ),
    origin: "https://identity.example.test",
    activeCookie: inMemoryIdentityCookie("active"),
    otherCookie: inMemoryIdentityCookie("other"),
    expiredCookie: inMemoryIdentityCookie("expired"),
    account,
  });
});
