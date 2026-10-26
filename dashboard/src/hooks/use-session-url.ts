import { useCallback, useEffect, useState } from 'react';

function readSession(): string | null {
  return new URL(window.location.href).searchParams.get('session') || null;
}

/** Session links are browser history entries; auth parameters are left untouched. */
export function useSessionUrl() {
  const [sessionId, setSessionId] = useState(readSession);
  useEffect(() => {
    const restore = () => setSessionId(readSession());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const selectSession = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('session', id);
    else url.searchParams.delete('session');
    // Invariant: commit navigation before rendering the dependent conversation.
    if (url.href !== window.location.href) window.history.pushState({}, '', url);
    setSessionId(id);
  }, []);
  return [sessionId, selectSession] as const;
}
