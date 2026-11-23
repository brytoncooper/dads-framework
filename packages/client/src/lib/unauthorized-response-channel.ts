/**
 * The one place a 401 is announced, and the one place a listener hears it.
 *
 * What this channel carries is a FACT, not a conclusion: the API refused a
 * request for lack of a session. It deliberately does not say "the session
 * expired", because the transport cannot know that. A 401 is equally the
 * answer to "who is this?" asked by a browser that has never been signed in,
 * by a browser holding a cookie from a database that no longer exists, and by
 * a browser whose live session lapsed thirty seconds ago. Only the client that
 * owns session state can tell those apart, and it does.
 *
 * A channel rather than a callback option on each request because any request
 * can be the one that discovers a 401, and the interpretation of it has to be
 * made in one place rather than at every call site.
 */

/** Notified once per request that came back 401. */
export type UnauthorizedResponseListener = () => void;

const listeners = new Set<UnauthorizedResponseListener>();

/**
 * Subscribe to refused requests. Returns the unsubscribe function, so a caller
 * that mounts and unmounts (a React effect, a test) can undo itself.
 */
export function onUnauthorizedResponse(
  listener: UnauthorizedResponseListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce that a request was refused for lack of a session.
 *
 * Not exported from the barrel: only the transport's own request path may say
 * this, because only it has seen a real 401 from the API.
 */
export function announceUnauthorizedResponse(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
