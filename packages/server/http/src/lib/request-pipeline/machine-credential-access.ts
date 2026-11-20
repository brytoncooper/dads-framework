import { HttpWiringError } from "../http-errors.js";
import type { RouteCapabilities } from "../route/capabilities.js";
import type { HttpRoute } from "../route/route-group.js";
import type { SubjectResolver } from "./enforce-access.js";

/** The one option a machine-credential route reads beyond the access ports. */
type MachineCredentialOptions = {
  readonly subjects: SubjectResolver;
  readonly machineCredentials?: Readonly<Record<string, SubjectResolver>>;
};

/**
 * The options one route enforces access with: a route declaring
 * `capabilities.machineCredential` swaps the session resolver for its named
 * machine resolver, so its caller can only be that machine. Wiring mistakes
 * (a public route, a missing resolver) throw at registration, never per request.
 */
export function routeOptionsFor<Options extends MachineCredentialOptions>(
  definition: HttpRoute,
  options: Options,
): Options {
  const name = definition.capabilities.machineCredential;
  if (name === undefined) return options;
  const where = `${definition.method} ${definition.path}`;
  if (definition.access.kind === "public") {
    throw new HttpWiringError(
      `${where} declares machineCredential "${name}" on a public route — a machine credential needs an access declaration that resolves a subject`,
    );
  }
  const resolver = options.machineCredentials?.[name];
  if (resolver === undefined) {
    throw new HttpWiringError(
      `${where} declares machineCredential "${name}" but registerRoutes received no machineCredentials["${name}"] resolver`,
    );
  }
  return { ...options, subjects: resolver };
}

/** A machine credential is declared by a route or its group, never app-wide. */
export function assertNoAppMachineCredential(
  capabilities: RouteCapabilities | undefined,
): void {
  if (capabilities?.machineCredential !== undefined) {
    throw new HttpWiringError(
      "registerRoutes capabilities.machineCredential is not allowed — a machine credential is declared by a route or its group, never app-wide",
    );
  }
}
