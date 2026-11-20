import * as React from "react";

/**
 * Hold a callback behind a stable identity, so passing it as a prop does not
 * re-render and naming it as a dependency does not re-run the effect.
 *
 * Ported from radix-ui's `useCallbackRef`, retyped over the argument list
 * instead of the function type so the returned wrapper needs no assertion.
 */
function useCallbackRef<TArgs extends unknown[], TResult>(
  callback: ((...args: TArgs) => TResult) | undefined,
): (...args: TArgs) => TResult | undefined {
  const callbackRef = React.useRef(callback);

  React.useEffect(() => {
    callbackRef.current = callback;
  });

  return React.useCallback(
    (...args: TArgs) => callbackRef.current?.(...args),
    [],
  );
}

export { useCallbackRef };
