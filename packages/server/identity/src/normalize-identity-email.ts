const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Normalize an email before addressing a message or comparing an invitation. */
export function normalizeIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}
