import type { ScimEmail, ScimName, ScimUserData } from "./directory.js";
import { attributes, ScimError } from "./protocol.js";

export const nameAttributes = [
  "formatted",
  "familyName",
  "givenName",
  "middleName",
  "honorificPrefix",
  "honorificSuffix",
] satisfies readonly (keyof ScimName)[];

export function userString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new ScimError(400, "Expected a string attribute.", "invalidValue");
}

function parseName(value: unknown): ScimName | undefined {
  if (value === undefined || value === null) return undefined;
  const fields = attributes(value);
  return Object.fromEntries(
    nameAttributes.flatMap((key) => {
      const item = userString(fields[key.toLowerCase()]);
      return item === undefined ? [] : [[key, item]];
    }),
  );
}

function parseEmail(value: unknown): ScimEmail {
  const fields = attributes(value);
  const email = userString(fields["value"]);
  const type = userString(fields["type"]);
  const display = userString(fields["display"]);
  const primary = fields["primary"];
  if (
    !email?.trim() ||
    (primary !== undefined && typeof primary !== "boolean")
  ) {
    throw new ScimError(400, "Invalid email attribute.", "invalidValue");
  }
  return {
    value: email,
    ...(type === undefined ? {} : { type }),
    ...(display === undefined ? {} : { display }),
    ...(primary === undefined ? {} : { primary }),
  };
}

function parseEmails(value: unknown): readonly ScimEmail[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new ScimError(400, "Expected an email list.", "invalidValue");
  const emails = value.map(parseEmail);
  if (emails.filter((email) => email.primary).length > 1) {
    throw new ScimError(400, "Only one email can be primary.", "invalidValue");
  }
  return emails;
}

export function parseScimUser(
  input: unknown,
  defaultActive = true,
): ScimUserData {
  const fields = attributes(input);
  const userName = userString(fields["username"]);
  const active = fields["active"] ?? defaultActive;
  const externalId = userString(fields["externalid"]);
  const displayName = userString(fields["displayname"]);
  const name = parseName(fields["name"]);
  const emails = parseEmails(fields["emails"]);
  if (!userName?.trim() || typeof active !== "boolean") {
    throw new ScimError(
      400,
      "A userName string and a boolean active value are required.",
      "invalidValue",
    );
  }
  return {
    userName,
    active,
    ...(externalId === undefined ? {} : { externalId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(name === undefined ? {} : { name }),
    ...(emails === undefined ? {} : { emails }),
  };
}
