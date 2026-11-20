import * as React from "react";

import { useCallbackRef } from "./use-callback-ref.js";

/**
 * Run a callback only once the caller stops calling it for `delay` ms.
 *
 * Ported from Mantine's `use-debounced-callback`, retyped over the argument
 * list so the returned function keeps the caller's parameters.
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number,
): (...args: TArgs) => void {
  const handleCallback = useCallbackRef(callback);
  const debounceTimerRef = React.useRef(0);

  React.useEffect(
    () => () => {
      window.clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  return React.useCallback(
    (...args: TArgs) => {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = window.setTimeout(() => {
        handleCallback(...args);
      }, delay);
    },
    [handleCallback, delay],
  );
}
