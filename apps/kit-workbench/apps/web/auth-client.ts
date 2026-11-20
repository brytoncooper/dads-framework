import { ApiError } from "@dads-framework/client-request-transport";
import { z } from "zod";

const account = z.object({
  id: z.string(),
  email: z.email(),
});
const session = z.object({ account }).nullable();

type Credentials = { readonly email: string; readonly password: string };

async function authRequest(
  path: string,
  options?: { readonly body: object } | { readonly signal: AbortSignal },
) {
  const response = await fetch(
    `/api/auth/${path}`,
    options && "body" in options
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : { signal: options?.signal ?? null },
  );
  if (!response.ok) {
    const rejectedSignIn =
      path === "sign-in/email" &&
      (response.status === 400 ||
        response.status === 401 ||
        response.status === 403);
    throw new ApiError(
      response.status,
      rejectedSignIn ? "AUTH_SIGN_IN_REFUSED" : "AUTH_REQUEST_REFUSED",
      "Authentication request refused",
    );
  }
  return response;
}

export function readAccount(signal?: AbortSignal) {
  return authRequest("get-session", signal ? { signal } : undefined)
    .then((response) => response.json())
    .then((value: unknown) => session.parse(value)?.account ?? null);
}

export async function signIn(credentials: Credentials) {
  await authRequest("sign-in/email", { body: credentials });
  const account = await readAccount();
  if (account === null)
    throw new Error("The browser did not retain the session cookie.");
  return account;
}

export async function signUp(
  credentials: Credentials & { readonly name: string },
) {
  await authRequest("sign-up/email", {
    body: { ...credentials, callbackURL: "/" },
  });
}

export async function signOut() {
  await authRequest("sign-out", { body: {} });
}

export type Account = z.output<typeof account>;
