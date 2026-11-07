import { useEffect, useRef } from 'react';

// Screens stay mounted while hidden; refresh quietly when one becomes visible again so counts are never stale.
export function useRefreshOnReturn(active: boolean, refresh: () => void) {
  const wasActive = useRef(active);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (active && !wasActive.current) refreshRef.current();
    wasActive.current = active;
  }, [active]);
}
