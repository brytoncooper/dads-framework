import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { runNodePgMigrations } from "@dads-framework/migrations";
import { startUnmigratedTestPostgres } from "@dads-framework/postgres/testing";
import { IdentityProvider, SamlLib, ServiceProvider } from "samlify";
import { expect, it, vi } from "vitest";
import {
  createEnterpriseBetterAuthIdentity,
  enterpriseSsoDomainChallenge,
  type EnterpriseSsoProvider,
} from "@dads-framework/identity-better-auth";

vi.mock("node:dns/promises", () => ({ resolveTxt: vi.fn() }));

it("authenticates a signed SAML assertion from the initiating browser and rejects replay and subject or domain substitution", async () => {
  const database = await startUnmigratedTestPostgres({ attributed: false });
  const directory = await mkdtemp(join(tmpdir(), "dads-saml-idp-"));
  try {
    const keyFile = join(directory, "key.pem");
    const certFile = join(directory, "certificate.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "1",
      "-subj",
      "/CN=fixture.idp.test",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ]);
    const [privateKey, signingCertificate] = await Promise.all([
      readFile(keyFile, "utf8"),
      readFile(certFile, "utf8"),
    ]);
    await runNodePgMigrations({
      databaseUrl: database.connectionString,
      workspace: {
        root: fileURLToPath(new URL("..", import.meta.url)),
        sources: [
          {
            root: "src/lib/migrations",
            files: /^src\/lib\/migrations\/[^/]+\.migration\.ts$/u,
            required: true,
            owner: "identity-better-auth",
          },
        ],
        moduleAliases: {},
      },
    });
    const origin = "https://identity.example.test";
    const secret = randomBytes(32).toString("hex");
    const provider = {
      id: "sso-saml",
      tenantId: "tenant-saml",
      domain: "example.test",
      mode: "optional",
      protocol: "saml",
      entityId: "https://fixture.idp.test/saml",
      signInUrl: "https://fixture.idp.test/sign-in",
      emailAttribute: "email",
      signingCertificate,
    } satisfies EnterpriseSsoProvider;
    const proof = enterpriseSsoDomainChallenge(
      secret,
      provider.tenantId,
      provider.domain,
    );
    vi.mocked(resolveTxt).mockImplementation((name) =>
      Promise.resolve(name === proof.name ? [[proof.value]] : []),
    );
    const identity = await createEnterpriseBetterAuthIdentity(
      {
        database,
        baseUrl: origin,
        secret,
        canInvite: () => Promise.resolve(false),
        enqueueEmail: () => Promise.resolve(),
      },
      [provider],
    );

    const metadata = await identity.handle(
      new Request(
        `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${provider.id}`,
      ),
    );
    expect(metadata.status).toBe(200);
    const sp = ServiceProvider({
      metadata: await metadata.text(),
      wantMessageSigned: true,
    });
    const idp = IdentityProvider({
      entityID: provider.entityId,
      privateKey,
      signingCert: signingCertificate,
      requestSignatureAlgorithm:
        "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      nameIDFormat: ["urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"],
      singleSignOnService: [
        {
          Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
          Location: provider.signInUrl,
        },
      ],
    });
    const acs = `${origin}/api/auth/sso/saml2/sp/acs/${provider.id}`;
    let address = 10;
    async function roundtrip(subject: string, email: string) {
      const start = await identity.handle(
        new Request(origin + "/api/auth/sign-in/sso", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": `192.0.2.${String(address++)}`,
          },
          body: JSON.stringify({
            providerId: provider.id,
            callbackURL: "/welcome",
          }),
        }),
      );
      expect(start.status).toBe(200);
      const payload: unknown = await start.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("url" in payload) ||
        typeof payload.url !== "string"
      )
        throw new Error("Expected SAML authorization URL.");
      const redirect = new URL(payload.url);
      const relay = redirect.searchParams.get("RelayState");
      const requestId = inflateRawSync(
        Buffer.from(redirect.searchParams.get("SAMLRequest") ?? "", "base64"),
      )
        .toString("utf8")
        .match(/\bID="([^"]+)"/u)?.[1];
      if (relay === null || requestId === undefined)
        throw new Error("Expected a SAML request and RelayState.");
      const assertion = await idp.createLoginResponse(
        sp,
        { extract: { request: { id: requestId } } },
        "post",
        { email: subject },
        {
          relayState: relay,
          customTagReplacement: (template) => ({
            id: "unused-test-renderer-id",
            context: render(
              template,
              sp.entityMeta.getEntityID(),
              acs,
              provider.entityId,
              requestId,
              subject,
              email,
            ),
          }),
        },
      );
      return {
        cookie: browserCookies(start),
        body: { RelayState: relay, SAMLResponse: assertion.context },
      };
    }

    function callback(body: Record<string, string>, cookie = "") {
      return identity.handle(
        new Request(acs, {
          method: "POST",
          headers: { cookie },
          body: new URLSearchParams(body),
        }),
      );
    }

    const email = "saml-user@example.test";
    const first = await roundtrip("subject-1", email);
    expect(first.cookie).toContain("__Host-dads-sso-relay");
    expect((await callback(first.body)).status).toBe(403);
    const success = await callback(first.body, first.cookie);
    expect(success.status, await success.clone().text()).toBe(302);
    expect(success.headers.get("location")).toBe(origin + "/welcome");
    const headers = new Headers({ cookie: browserCookies(success) });
    const original = await identity.readEnterpriseSession(
      headers,
      provider.tenantId,
      60_000,
    );
    expect(original?.account).toMatchObject({ email, emailVerified: true });
    expect(original?.providerId).toBe(provider.id);
    expect(
      await identity.readEnterpriseSession(headers, "wrong-tenant"),
    ).toBeNull();
    expect(
      await identity.readEnterpriseSession(headers, provider.tenantId, -1),
    ).toBeNull();
    expect(
      browserCookies(await callback(first.body, first.cookie)),
    ).not.toContain("session_token");

    await database.pool.query(
      `UPDATE identity_sessions SET "createdAt" = now() - interval '10 minutes' WHERE id = $1`,
      [original?.sessionId],
    );
    expect(
      await identity.readEnterpriseSession(headers, provider.tenantId, 60_000),
    ).toBeNull();

    const repeated = await roundtrip("subject-1", email);
    const refreshed = await callback(repeated.body, repeated.cookie);
    const fresh = await identity.readEnterpriseSession(
      new Headers({ cookie: browserCookies(refreshed) }),
      provider.tenantId,
      60_000,
    );
    expect(fresh?.account.id).toBe(original?.account.id);
    expect(fresh?.authenticatedAt.getTime()).toBeGreaterThan(
      original?.authenticatedAt.getTime() ?? 0,
    );

    const wrongSubject = await roundtrip("substitute-subject", email);
    expect(
      browserCookies(await callback(wrongSubject.body, wrongSubject.cookie)),
    ).not.toContain("session_token");
    const wrongDomain = await roundtrip("subject-1", "another@outside.test");
    expect(
      browserCookies(await callback(wrongDomain.body, wrongDomain.cookie)),
    ).not.toContain("session_token");
    const tampered = await roundtrip("subject-1", email);
    const assertion = Buffer.from(tampered.body.SAMLResponse, "base64")
      .toString("utf8")
      .replace(email, "tampered@example.test");
    expect(
      browserCookies(
        await callback(
          {
            ...tampered.body,
            SAMLResponse: Buffer.from(assertion).toString("base64"),
          },
          tampered.cookie,
        ),
      ),
    ).not.toContain("session_token");
  } finally {
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

function render(
  template: string,
  audience: string,
  acs: string,
  issuer: string,
  requestId: string,
  subject: string,
  email: string,
) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 120_000).toISOString();
  const withClaims = template
    .replace(
      "{AttributeStatement}",
      '<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>{FixtureEmail}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>',
    )
    .replace(
      "{AuthnStatement}",
      '<saml:AuthnStatement AuthnInstant="{IssueInstant}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>',
    );
  return SamlLib.renderTags(withClaims, {
    ID: `_${crypto.randomUUID()}`,
    AssertionID: `_${crypto.randomUUID()}`,
    Destination: acs,
    Audience: audience,
    EntityID: audience,
    SubjectRecipient: acs,
    Issuer: issuer,
    IssueInstant: now,
    AssertionConsumerServiceURL: acs,
    StatusCode: "urn:oasis:names:tc:SAML:2.0:status:Success",
    ConditionsNotBefore: now,
    ConditionsNotOnOrAfter: expires,
    SubjectConfirmationDataNotOnOrAfter: expires,
    NameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    NameID: subject,
    InResponseTo: requestId,
    FixtureEmail: email,
  });
}

function browserCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
