/**
 * What the three online signals refuse to do.
 *
 * The corpus proves what they read when a registry and a forge answer them.
 * This proves the refusals, which no fixture can show because a fixture that
 * trips a signal is a fixture where everything went right: an offline run
 * reaches nothing, a run with no day measures no age, a request carries a
 * deadline and is never asked twice, a status that is not 200 is a failure
 * rather than a zero, and a remote that is not a GitHub repository is a
 * question that goes unasked.
 */

import { describe, expect, it } from "vitest";
import {
  createDoctorContext,
  NOT_MEASURED_OFFLINE,
  type DoctorContext,
  type DoctorFetch,
} from "./doctor-context.js";
import { runDoctorSignals } from "./doctor-signals.js";
import { ONLINE_SIGNALS } from "./signals/registry/online.js";
import {
  parseRemoteUrl,
  readJsonObject,
} from "./signals/scanners/online-requests.js";
import { unmaintainedDependenciesSignal } from "./signals/you-stay-with-people-who-cannot-meet-you/unmaintained-dependencies.js";

const ORIGIN = "git@github.com:fixture-owner/fixture-repo.git";
const REPOSITORY = "https://api.github.com/repos/fixture-owner/fixture-repo";
const REFUSED = 503;

/** A context that answers `origin` and hands every request to `transport`. */
function onlineContext(transport: DoctorFetch): DoctorContext {
  return createDoctorContext({
    root: process.cwd(),
    today: "2026-09-06",
    files: [],
    exec: () => ({ status: 0, stdout: `${ORIGIN}\n` }),
    online: true,
    fetch: transport,
  });
}

async function failuresOf(context: DoctorContext): Promise<readonly string[]> {
  const outcomes = await runDoctorSignals(context, ONLINE_SIGNALS);
  return outcomes.map((outcome) => outcome.failure ?? "measured");
}

describe("a doctor run that was not given a network", () => {
  it("reports every online signal as not measured, with the reason", async () => {
    const context = createDoctorContext({ root: process.cwd(), files: [] });

    expect(await failuresOf(context)).toStrictEqual([
      NOT_MEASURED_OFFLINE,
      NOT_MEASURED_OFFLINE,
      NOT_MEASURED_OFFLINE,
    ]);
  });

  it("refuses the request itself, so no signal can reach out by forgetting", async () => {
    const context = createDoctorContext({ root: process.cwd(), files: [] });

    await expect(context.fetch(REPOSITORY)).rejects.toThrow(
      NOT_MEASURED_OFFLINE,
    );
  });
});

describe("a doctor run that was given a network but no day", () => {
  it("reports the age of a dependency as not measured rather than asking a clock", async () => {
    const context = createDoctorContext({
      root: process.cwd(),
      files: [],
      online: true,
      fetch: () => {
        throw new Error("nothing should be asked without a day");
      },
    });
    const outcomes = await runDoctorSignals(context, [
      unmaintainedDependenciesSignal,
    ]);

    expect(outcomes.map((outcome) => outcome.failure)).toStrictEqual([
      "no --today given",
    ]);
  });
});

describe("a request the doctor makes", () => {
  it("carries a deadline it did not have to be asked for", async () => {
    const deadlines: AbortSignal[] = [];
    const context = onlineContext((_url, init) => {
      deadlines.push(init.signal);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve("{}"),
      });
    });

    await context.fetch(REPOSITORY);

    expect(deadlines.map((signal) => signal.aborted)).toStrictEqual([false]);
  });

  it("is not retried when the deadline it carries expires", async () => {
    let asked = 0;
    const context = onlineContext(() => {
      asked += 1;
      return Promise.reject(new Error("The operation was aborted"));
    });

    await expect(context.fetch(REPOSITORY)).rejects.toThrow("aborted");
    expect(asked).toBe(1);
  });

  it("is a failure naming the status when the answer is not 200", async () => {
    const context = onlineContext(() =>
      Promise.resolve({
        status: REFUSED,
        text: () => Promise.resolve("upstream is unwell"),
      }),
    );

    await expect(readJsonObject(context, REPOSITORY)).rejects.toThrow(
      `${REPOSITORY} answered ${REFUSED}`,
    );
  });

  it("is a failure when a 200 carries a body that is not a JSON object", async () => {
    const context = onlineContext(() =>
      Promise.resolve({ status: 200, text: () => Promise.resolve("<html>") }),
    );

    await expect(readJsonObject(context, REPOSITORY)).rejects.toThrow(
      "answered 200 with no JSON object",
    );
  });
});

describe("the repository a remote names", () => {
  it("reads the owner and the repository out of every shape origin is written in", () => {
    const named = [
      "https://github.com/fixture-owner/fixture-repo.git",
      "https://github.com/fixture-owner/fixture-repo",
      "https://someone@github.com/fixture-owner/fixture-repo.git",
      "git@github.com:fixture-owner/fixture-repo.git",
      "ssh://git@github.com/fixture-owner/fixture-repo.git",
      "  git@github.com:fixture-owner/fixture-repo  ",
    ].map((url) => parseRemoteUrl(url));
    const expected = { owner: "fixture-owner", repository: "fixture-repo" };

    expect(named).toStrictEqual([
      expected,
      expected,
      expected,
      expected,
      expected,
      expected,
    ]);
  });

  it("names nothing for a remote this signal cannot ask about", () => {
    const named = [
      "https://gitlab.example/fixture-owner/fixture-repo.git",
      "git@example.invalid:fixture-owner/fixture-repo.git",
      "/home/someone/fixture-repo",
      "https://github.com/fixture-owner",
      "",
    ].map((url) => parseRemoteUrl(url));

    expect(named).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
