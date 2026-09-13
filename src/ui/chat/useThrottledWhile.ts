import { useEffect, useRef, useState } from 'react';

/**
 * Clamp a rapidly changing value while `active`, always publishing the newest
 * pending value on the next cadence tick. Deactivation synchronizes the final
 * value immediately.
 */
export function useThrottledWhile<T>(value: T, ms: number, active: boolean): T {
  const [displayValue, setDisplayValue] = useState(value);
  const latestRef = useRef(value);
  const lastPublishedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = value;
    if (!active) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      lastPublishedRef.current = performance.now();
      setDisplayValue(value);
      return;
    }

    if (timerRef.current !== null) return;
    const elapsed = performance.now() - lastPublishedRef.current;
    const wait = Math.max(0, ms - elapsed);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastPublishedRef.current = performance.now();
      setDisplayValue(latestRef.current);
    }, wait);
  }, [value, active, ms]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return displayValue;
}
