"use client";

import { useCallback, useEffect, useState } from "react";

/** Debounces high-frequency search input and exposes a flush for explicit 조회. */
export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  const flush = useCallback(() => setDebounced(value), [value]);
  return [debounced, flush] as const;
}
