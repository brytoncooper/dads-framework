import type { EmailAddress } from "../../core/index.js";

/**
 * A display name holding any of these would change what the header means: a
 * comma splits one addressee into two, an angle bracket ends the address, a
 * quote closes the quoted form early, and a non-ASCII byte is not permitted
 * unquoted. Everything matching gets the quoted form instead.
 */
const NEEDS_QUOTING = /["<>,\\]|[^ -~]/;

/** One addressee as a mail header renders it: `addr` or `Name <addr>`. */
export function formatEmailAddress(address: EmailAddress): string {
  const name = address.name?.trim();
  if (name === undefined || name === "") return address.address;
  if (!NEEDS_QUOTING.test(name)) return `${name} <${address.address}>`;
  return `"${escapeQuotedName(name)}" <${address.address}>`;
}

/** Every addressee in one header value, in the order given. */
export function formatEmailAddresses(addresses: readonly EmailAddress[]): string {
  return addresses.map(formatEmailAddress).join(", ");
}

function escapeQuotedName(name: string): string {
  return name.replace(/([\\"])/g, "\\$1");
}
