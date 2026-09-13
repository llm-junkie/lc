import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Coalesce rapidly changing render input to one animation-frame commit and
 * notify only after React has placed that committed value in the DOM.
 */
export function useRafCommittedValue<T>(
  value: T,
  onCommitted?: (value: T) => void,
): T {
  const [committed, setCommitted] = useState(value);
  const latestValueRef = useRef(value);
  const onCommittedRef = useRef(onCommitted);

  useEffect(() => {
    latestValueRef.current = value;
    const frame = requestAnimationFrame(() => {
      if (latestValueRef.current === value) setCommitted(value);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  useLayoutEffect(() => {
    onCommittedRef.current = onCommitted;
  });
  useLayoutEffect(() => {
    onCommittedRef.current?.(committed);
  }, [committed]);

  return committed;
}
