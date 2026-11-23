import assert from "node:assert/strict";
import type { Identity, IdentityAccount } from "../identity-types.js";

export type IdentitySessionConformance = {
  readonly identity: Identity;
  readonly origin: string;
  readonly activeCookie: string;
  readonly otherCookie: string;
  readonly expiredCookie: string;
  readonly account: IdentityAccount;
};

/** Apply the same session laws to a stand-in and a database-backed provider. */
export async function verifyIdentitySessionConformance(input: IdentitySessionConformance): Promise<void> {
  const { identity, origin, activeCookie, otherCookie, expiredCookie, account } = input;
  const active = new Headers({ cookie: activeCookie });
  const other = new Headers({ cookie: otherCookie });
  const expired = new Headers({ cookie: expiredCookie });

  assert.equal(await identity.readSession(new Headers()), null);
  assert.equal(await identity.readSession(expired), null);
  const current = await identity.readSession(active);
  assert.ok(current);
  assert.deepEqual(current.account, account);
  assert.ok(current.expiresAt instanceof Date);
  assert.ok(await identity.readSession(other));

  const projection = await identity.handle(new Request(`${origin}/api/auth/get-session`, { headers: active }));
  assert.equal(projection.status, 200);
  const body: unknown = await projection.json();
  assert.deepEqual(body, {
    account,
    expiresAt: current.expiresAt.toISOString(),
  });

  const signedOut = await identity.handle(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: new Headers({ cookie: activeCookie, origin }),
    }),
  );
  assert.equal(signedOut.status, 200);
  assert.equal(await identity.readSession(active), null);
  assert.ok(await identity.readSession(other));
}
