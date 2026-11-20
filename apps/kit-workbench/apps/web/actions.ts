import { readClientFailure } from "@dads-framework/client-request-transport";
import { useState, type SubmitEvent } from "react";
import type { WorkbenchCopyKey } from "./copy/workbench-copy.js";

const refusalCopy: Readonly<Partial<Record<number, WorkbenchCopyKey>>> = {
  400: "workbench.error.input",
  401: "workbench.error.session",
  403: "workbench.error.forbidden",
  404: "workbench.error.missing",
  409: "workbench.error.conflict",
  422: "workbench.error.input",
  429: "workbench.error.rate",
};

export function describeFailure(error: unknown): WorkbenchCopyKey {
  const failure = readClientFailure(error);
  if (failure.kind === "session-expired") return "workbench.error.session";
  if (failure.kind === "network") return "workbench.error.network";
  if (failure.kind !== "api") return "workbench.error.generic";
  if (failure.code === "AUTH_SIGN_IN_REFUSED") return "workbench.error.signIn";
  return refusalCopy[failure.status] ?? "workbench.error.generic";
}

export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<WorkbenchCopyKey>();
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setError(undefined);
    setPending(true);
    try {
      await action();
    } catch (fault) {
      setError(describeFailure(fault));
    } finally {
      setPending(false);
    }
  }

  function submit(
    event: SubmitEvent<HTMLFormElement>,
    action: (form: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() => action(form));
  }

  return { pending, error, run, submit };
}

export function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
