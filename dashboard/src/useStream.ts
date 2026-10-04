import { useEffect, useRef, useState } from 'react';
import type { AlertEvent, Snapshot } from './types';

export type ConnState = 'connecting' | 'open' | 'error';

/** Subscribes to the watcher's Server-Sent Events stream. EventSource reconnects on its own. */
export function useStream(url = '/api/stream') {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [flash, setFlash] = useState<AlertEvent | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const es = new EventSource(url);
    es.onopen = () => setConn('open');
    es.onerror = () => setConn('error');
    es.addEventListener('snapshot', (e) => {
      setConn('open');
      setSnap(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener('alert', (e) => {
      const a = JSON.parse((e as MessageEvent).data) as AlertEvent;
      setFlash(a);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 6000);
    });
    return () => es.close();
  }, [url]);

  return { snap, conn, flash };
}
