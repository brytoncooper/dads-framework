/** Mixed technical routes retain raw technical identity only when context is absent; supplied context can never fall back. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildOpenApiDocument } from "../openapi/build-document.js";
import {
  fromHeader,
  fromQuery,
  requireSession,
  type RouteAccess,
  withTechnicalOrBusinessAuthorizationContext,
} from "../route/access.js";
import { getRoute } from "../route/get-route.js";
import { routeGroup } from "../route/route-group.js";
import { type AccessPorts, enforceAccess } from "./enforce-access.js";

const USER = { type: "user", id: "technical-user" };
const ACTOR = { type: "test/company_actor", id: "company/technical-user" };
const declarations: Exclude<RouteAccess, { kind: "public" }>[] = [
  requireSession(),
  {
    kind: "permission",
    resourceType: "test/machine",
    permission: "view",
    resourceId: { kind: "fixed", id: "machine" },
  },
  { kind: "visibility", resourceType: "test/machine", permission: "view" },
];

describe("technical-or-business context", () => {
  it("lets facilities/edge_device subjects skip business context entirely", async () => {
    const device = { type: "facilities/edge_device", id: "device-1" };
    const access = withTechnicalOrBusinessAuthorizationContext(requireSession(), fromHeader("x-test-caller-context"));
    const ports: AccessPorts = {
      subjects: { resolve: () => Promise.resolve(device) },
      authorization: { check: () => Promise.resolve(true) },
      authorizationContexts: {
        execute: () => Promise.resolve({ subject: ACTOR }),
      },
    };
    expect(await enforceAccess(access, { headers: {}, params: {} }, ports)).toEqual({
      outcome: "allow",
      subject: device,
      authenticatedSubject: device,
      accessKind: "session",
    });
  });

  it("distinguishes an absent SSE context query from a malformed or unauthorized supplied value", async () => {
    const access = withTechnicalOrBusinessAuthorizationContext(requireSession(), fromQuery("authorizationContext"));
    const ports: AccessPorts = {
      subjects: { resolve: () => Promise.resolve(USER) },
      authorization: { check: () => Promise.resolve(true) },
      authorizationContexts: {
        execute: (_identity, value) => Promise.resolve(value === "company:valid" ? { subject: ACTOR } : null),
      },
    };
    expect(await enforceAccess(access, { headers: {}, params: {}, query: {} }, ports)).toMatchObject({
      outcome: "allow",
      subject: USER,
    });
    expect(
      await enforceAccess(
        access,
        {
          headers: {},
          params: {},
          query: { authorizationContext: "company:valid" },
        },
        ports,
      ),
    ).toMatchObject({ outcome: "allow", subject: ACTOR });
    for (const value of ["", "company:invalid", ["company:valid", "company:other"], null]) {
      expect(
        await enforceAccess(access, { headers: {}, params: {}, query: { authorizationContext: value } }, ports),
      ).toEqual({
        outcome: "not-found",
        subject: null,
        authenticatedSubject: USER,
      });
    }
  });
  it("documents optionality as explicit technical identity selection", () => {
    const routes = routeGroup("Technical proof", [
      getRoute({
        path: "/technical",
        summary: "Technical or selected business",
        access: withTechnicalOrBusinessAuthorizationContext(requireSession(), fromHeader("x-test-caller-context")),
        response: z.object({ ok: z.boolean() }),
        handler: () => ({ ok: true }),
      }),
    ]);
    const document = buildOpenApiDocument(routes, {
      title: "Proof",
      description: "Proof",
      version: "1",
      pathPrefix: "/api",
      tags: [],
    });
    expect(document).toMatchObject({
      paths: {
        "/api/technical": {
          get: {
            parameters: [
              {
                in: "header",
                name: "x-test-caller-context",
                required: false,
                description:
                  "Omission selects authenticated technical identity; a supplied business context must resolve and never falls back to technical identity",
              },
            ],
          },
        },
      },
    });
  });
  it.each(declarations)("selects one subject for $kind and retains real audit identity", async (declaration) => {
    const checked: unknown[] = [];
    const ports: AccessPorts = {
      subjects: { resolve: () => Promise.resolve(USER) },
      authorization: {
        check: (query) => {
          checked.push(query.subject);
          return Promise.resolve(true);
        },
      },
      lookups: {
        lookupResources: (query) => {
          checked.push(query.subject);
          return Promise.resolve(["machine"]);
        },
      },
      authorizationContexts: {
        execute: (_identity, input) => Promise.resolve(input === "company:valid" ? { subject: ACTOR } : null),
      },
    };
    const access = withTechnicalOrBusinessAuthorizationContext(declaration, fromHeader("x-test-caller-context"));
    expect(await enforceAccess(access, { headers: {}, params: {} }, ports)).toMatchObject({
      outcome: "allow",
      subject: USER,
      authenticatedSubject: USER,
    });
    expect(
      await enforceAccess(access, { headers: { "x-test-caller-context": "company:valid" }, params: {} }, ports),
    ).toMatchObject({
      outcome: "allow",
      subject: ACTOR,
      authenticatedSubject: USER,
    });
    if (declaration.kind !== "session") expect(checked).toEqual([USER, ACTOR]);
    for (const value of [
      "company:invalid",
      "",
      " ",
      "company:valid, company:other",
      ["company:valid", "company:other"],
    ]) {
      expect(await enforceAccess(access, { headers: { "x-test-caller-context": value }, params: {} }, ports)).toEqual({
        outcome: "not-found",
        subject: null,
        authenticatedSubject: USER,
      });
    }
  });
});
