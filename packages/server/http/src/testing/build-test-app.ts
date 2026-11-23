import type { InjectOptions, LightMyRequestResponse } from "fastify";

import type { AccessModel } from "@dads-framework/access";
import { FakeAuthorization } from "@dads-framework/access/testing";

import { createHttpApp } from "../lib/create-http-app.js";
import type {
  AuthorizationContextResolver,
  PermissionChecker,
  SubjectResolver,
  VisibleResourceLookup,
} from "../lib/request-pipeline/enforce-access.js";
import type { FeatureStateProtocol } from "../lib/request-pipeline/feature-state.js";
import { registerRoutes } from "../lib/request-pipeline/register-routes.js";
import type { HttpRoute } from "../lib/route/route-group.js";

/**
 * Boots an HTTP app for tests with fakes pre-wired and returns `inject` —
 * NEVER a listening socket, so a test run cannot orphan a port or leave a
 * zombie listener (process-discipline bar; the type test pins that `listen`
 * does not exist on the harness).
 *
 * Defaults: the subject comes from the `x-test-subject` header (absent →
 * anonymous), and authorization DENIES everything — tests that exercise
 * permissions pass a seeded `FakeAuthorization`.
 */

/**
 * The harness's own subject header. Neutral on purpose — it is a fixture
 * channel between a test and `buildTestApp`, never a header any product's
 * client sends.
 */
export const TEST_SUBJECT_HEADER = "x-test-subject";

export type TestApp = {
  readonly inject: (options: InjectOptions) => Promise<LightMyRequestResponse>;
  readonly close: () => Promise<void>;
};

export type BuildTestAppOptions = {
  readonly routes: readonly HttpRoute[];
  readonly accessModel?: AccessModel;
  readonly lookups?: VisibleResourceLookup;
  readonly subjects?: SubjectResolver;
  /**
   * Resolvers for routes declaring `capabilities.machineCredential`; when
   * omitted, every declared name resolves through `subjects`.
   */
  readonly machineCredentials?: Readonly<Record<string, SubjectResolver>>;
  readonly authorization?: PermissionChecker;
  readonly authorizationContexts?: AuthorizationContextResolver;
  readonly handlerTimeoutMs?: number;
  /** Body media types a raw route under test needs the app to accept. */
  readonly rawBodyContentTypes?: readonly string[];
  /** Body media types a raw route under test needs the app to accept as bytes. */
  readonly byteBodyContentTypes?: readonly string[];
  /** The feature-state protocol, for routes whose answer depends on it. */
  readonly featureState?: FeatureStateProtocol;
};

function headerSubjects(): SubjectResolver {
  return {
    resolve: (request) => {
      const id = request.headers[TEST_SUBJECT_HEADER];
      return Promise.resolve(typeof id === "string" && id.length > 0 ? { type: "user", id } : null);
    },
  };
}

/** Routes under test that name a machine credential resolve it like any other caller. */
function sameSubjectsForEveryCredential(
  routes: readonly HttpRoute[],
  subjects: SubjectResolver,
): Readonly<Record<string, SubjectResolver>> {
  const names = routes.flatMap((route) =>
    route.capabilities.machineCredential === undefined ? [] : [route.capabilities.machineCredential],
  );
  return Object.fromEntries(names.map((name) => [name, subjects]));
}

function listAccessOptions(options: BuildTestAppOptions) {
  return {
    ...(options.accessModel === undefined ? {} : { accessModel: options.accessModel }),
    ...(options.lookups === undefined ? {} : { lookups: options.lookups }),
  };
}

export async function buildTestApp(options: BuildTestAppOptions): Promise<TestApp> {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    ...(options.rawBodyContentTypes === undefined ? {} : { rawBodyContentTypes: options.rawBodyContentTypes }),
    ...(options.byteBodyContentTypes === undefined ? {} : { byteBodyContentTypes: options.byteBodyContentTypes }),
  });
  const subjects = options.subjects ?? headerSubjects();
  registerRoutes(app, {
    routes: options.routes,
    ...listAccessOptions(options),
    subjects,
    machineCredentials: options.machineCredentials ?? sameSubjectsForEveryCredential(options.routes, subjects),
    authorization: options.authorization ?? new FakeAuthorization(),
    ...(options.authorizationContexts === undefined ? {} : { authorizationContexts: options.authorizationContexts }),
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs }),
    ...(options.featureState === undefined ? {} : { featureState: options.featureState }),
  });
  await app.ready();
  return {
    inject: (injectOptions) => app.inject(injectOptions),
    close: () => app.close(),
  };
}
