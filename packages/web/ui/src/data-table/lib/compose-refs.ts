/**
 * @see https://github.com/radix-ui/primitives/blob/main/packages/react/compose-refs/src/compose-refs.tsx
 */

import * as React from "react";

type PossibleRef<T> = React.Ref<T> | undefined;

/**
 * Set a given ref to a given value
 * This utility takes care of different types of refs: callback refs and RefObject(s)
 */
function setRef<T>(ref: PossibleRef<T>, value: T) {
  if (typeof ref === "function") {
    return ref(value);
  }

  if (ref !== null && ref !== undefined) {
    ref.current = value;
  }
}

/**
 * A utility to compose multiple refs together
 * Accepts callback refs and RefObject(s)
 */
function composeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  return (node) => {
    const cleanups = refs.map((ref) => setRef(ref, node));

    // React <19 logs an error when a callback ref returns a value. We do not
    // use ref cleanups internally, so this only happens when a caller's ref
    // callback returns one — the React 19 cleanup feature.
    const hasCleanup = cleanups.some((cleanup) => typeof cleanup === "function");
    if (!hasCleanup) return undefined;

    return () => {
      for (let i = 0; i < cleanups.length; i++) {
        const cleanup = cleanups[i];
        if (typeof cleanup === "function") {
          cleanup();
        } else {
          setRef(refs[i], null);
        }
      }
    };
  };
}

/**
 * A custom hook that composes multiple refs
 * Accepts callback refs and RefObject(s)
 */
function useComposedRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: we don't want to re-run this callback when the refs change
  return React.useCallback(composeRefs(...refs), refs);
}

export { composeRefs, useComposedRefs };
