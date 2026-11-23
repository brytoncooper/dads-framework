import { getFromApi } from "@dads-framework/client";
import { z } from "zod";
import { signInOptions, signInOptionsRoute } from "../../libraries/sign-in-options/index.js";

const enterpriseReturnParameter = "enterpriseSignIn";
const enterpriseStartResult = z.object({ url: z.url() });

export function readSignInOptions(signal: AbortSignal) {
  return getFromApi({
    route: signInOptionsRoute.bind(),
    returns: signInOptions,
    signal,
  });
}

export function returnedWithEnterpriseError(current: URL): boolean {
  return current.searchParams.get(enterpriseReturnParameter) === "1" && current.searchParams.has("error");
}

function returnTo(current: URL): URL {
  const callback = new URL(current);
  callback.searchParams.set(enterpriseReturnParameter, "1");
  callback.searchParams.delete("error");
  callback.searchParams.delete("error_description");
  return callback;
}

export async function beginEnterpriseSignIn(providerId: string, current: URL): Promise<string> {
  const response = await fetch("/api/auth/sign-in/sso", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, callbackURL: returnTo(current).href }),
  });
  if (!response.ok) throw new Error("The enterprise sign-in request failed.");

  const json: unknown = await response.json();
  const destination = new URL(enterpriseStartResult.parse(json).url);
  const localDevelopment = current.protocol === "http:" && current.origin === destination.origin;
  if ((destination.protocol !== "https:" && !localDevelopment) || destination.username || destination.password) {
    throw new Error("The enterprise sign-in destination is invalid.");
  }
  return destination.href;
}
