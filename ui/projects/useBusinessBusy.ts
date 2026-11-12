import { useCallback, useEffect, useRef, useState } from 'react';

/** Independent panes can save at once; one completed save must not hide another pending operation. */
export function useBusinessBusy(onBusy: (value: boolean) => void) {
  const active = useRef(new Set<string>());
  const reportRef = useRef(onBusy);
  reportRef.current = onBusy;
  const [busy, setBusy] = useState(false);
  const report = useCallback((scope: string, value: boolean) => {
    if (value) active.current.add(scope);
    else active.current.delete(scope);
    const next = active.current.size > 0;
    setBusy(next);
    reportRef.current(next);
  }, []);
  useEffect(() => () => { active.current.clear(); reportRef.current(false); }, []);
  return { busy, report };
}
