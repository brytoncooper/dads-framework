export function presentToken(token: string | undefined): string | undefined {
  return token !== undefined && token.length > 0 ? token : undefined;
}
