// useLiveOwner — polls the backend for which patient the single connected
// device is streaming for. The 8080 backend holds one device + one stream, so
// this tells a dashboard whether the live data actually belongs to the patient
// being viewed. Polling (not WS) keeps it decoupled from the sensor socket;
// a few-second lag on "who owns the stream" is fine.

import { useEffect, useState } from 'react';
import { liveApi, type LiveOwner } from '../api/client';

const POLL_MS = 2500;

export function useLiveOwner(): LiveOwner | null {
  const [owner, setOwner] = useState<LiveOwner | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await liveApi.getOwner();
        if (alive) setOwner(res.owner);
      } catch {
        /* backend momentarily unreachable — keep the last known owner */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return owner;
}
