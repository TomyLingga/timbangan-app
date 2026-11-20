import { createApiClient } from "@/lib/api-client";
import { API_URL } from "@/lib/config";

// One client per browser tab. It holds the access token in memory, so the
// token is gone on reload and is fetched again with the refresh cookie.

type Listener = () => void;

const signedOutListeners = new Set<Listener>();

export const api = createApiClient({
  baseUrl: API_URL,
  onSignedOut: () => {
    for (const listener of signedOutListeners) listener();
  },
});

/** Runs the listener when a session in use can no longer be renewed. */
export function onSignedOut(listener: Listener): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}
