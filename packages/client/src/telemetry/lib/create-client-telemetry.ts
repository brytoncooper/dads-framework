/**
 * The one place a driver is chosen.
 *
 * Mirrors `createEmailSender` on the server: a closed union, one branch each,
 * and a loud throw when a driver is asked for without what it needs. A
 * misconfigured reporter must not boot and silently drop every fault — that
 * is the failure mode this whole initiative exists to end.
 *
 * The union has three members and only two of them are a choice. `local` is
 * our own API and is what `local-and-vendor` is built on top of: there is no
 * member that sends to a vendor *instead*, because the record we own is not
 * something a vendor decision is allowed to trade away. Adding a
 * second vendor adds a loader, not a member.
 */

import { NoneClientTelemetry, type ClientTelemetry } from "../core/index.js";
import { FanOutClientTelemetry } from "./fan-out-client-telemetry.js";
import {
  LocalClientTelemetry,
  type LocalClientTelemetryOptions,
} from "./local-client-telemetry.js";
import {
  SentryClientTelemetry,
  type LoadVendorReporter,
} from "./sentry-client-telemetry.js";

export type ClientTelemetryDriver = "none" | "local" | "local-and-vendor";

export type CreateClientTelemetryOptions = {
  readonly driver: ClientTelemetryDriver;
  /** Required by `local`; the same-origin path the API serves. */
  readonly endpoint?: string;
  /** Required by `local`; the build stamp the SPA was baked with. */
  readonly release?: string;
  readonly clientContext?: LocalClientTelemetryOptions["clientContext"];
  readonly now?: LocalClientTelemetryOptions["now"];
  readonly send?: LocalClientTelemetryOptions["send"];
  /** Required by `local-and-vendor`; absent is what makes the vendor inert. */
  readonly vendorDsn?: string;
  /** Required by `local-and-vendor`; the same-origin path envelopes tunnel through. */
  readonly vendorTunnel?: string;
  /** Required by `local-and-vendor`; `production`, `staging`, a laptop. */
  readonly environment?: string;
  /** Injected by tests so the vendor can be proven without its SDK. */
  readonly loadVendor?: LoadVendorReporter;
};

export function createClientTelemetry(
  options: CreateClientTelemetryOptions,
): ClientTelemetry {
  if (options.driver === "none") return new NoneClientTelemetry();

  const local = createLocalTelemetry(options);
  if (options.driver === "local") return local;
  return new FanOutClientTelemetry([local, createVendorTelemetry(options)]);
}

function createLocalTelemetry(
  options: CreateClientTelemetryOptions,
): LocalClientTelemetry {
  const { endpoint, release, clientContext } = options;
  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error("client telemetry driver 'local' requires an endpoint");
  }
  if (release === undefined || release.length === 0) {
    throw new Error(
      "client telemetry driver 'local' requires a release — an unstamped build cannot say which code failed",
    );
  }
  return new LocalClientTelemetry({
    endpoint,
    release,
    clientContext: clientContext ?? (() => undefined),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.send === undefined ? {} : { send: options.send }),
  });
}

function createVendorTelemetry(
  options: CreateClientTelemetryOptions,
): SentryClientTelemetry {
  const { vendorDsn, vendorTunnel, environment, release } = options;
  // Thrown rather than quietly downgraded to `local`. Whoever selected this
  // driver believes faults are reaching a vendor; a silent fallback would let
  // that belief survive being wrong for months.
  if (vendorDsn === undefined || vendorDsn.length === 0) {
    throw new Error(
      "client telemetry driver 'local-and-vendor' requires a vendor DSN — select 'local' when there is no vendor",
    );
  }
  if (vendorTunnel === undefined || vendorTunnel.length === 0) {
    throw new Error(
      "client telemetry driver 'local-and-vendor' requires a tunnel path — envelopes are never sent to a third-party host directly",
    );
  }
  if (environment === undefined || environment.length === 0) {
    throw new Error(
      "client telemetry driver 'local-and-vendor' requires an environment — faults from staging and production must not group together",
    );
  }
  return new SentryClientTelemetry({
    dsn: vendorDsn,
    release: release ?? "",
    environment,
    tunnel: vendorTunnel,
    ...(options.loadVendor === undefined ? {} : { load: options.loadVendor }),
  });
}
