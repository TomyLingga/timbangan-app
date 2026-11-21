// The send queue wired to the phone: AsyncStorage, the network state from NetInfo, and the API client.
// It is paused while nobody is signed in and resumes after the next sign-in.

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { FileUploadResponse } from "../api/types";
import { photoFormData } from "../platform/upload";
import { type QueueInput, type QueueItem, SendQueue } from "../queue/queue";
import { createFormSender } from "../queue/sender";
import { useSession } from "./session";

interface QueueValue {
  ready: boolean;
  items: QueueItem[];
  online: boolean;
  paused: boolean;
  enqueue(input: QueueInput): Promise<void>;
  retryNow(): void;
  discard(clientUuid: string): Promise<void>;
  pendingFor(stepId: number): boolean;
}

const QueueContext = createContext<QueueValue | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const { api, status } = useSession();
  const [queue, setQueue] = useState<SendQueue | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};
    const send = createFormSender({
      upload: async (uri) => (await api.request<FileUploadResponse>("/api/files", { method: "POST", body: await photoFormData(uri), timeoutMs: 60_000 })).id,
      post: (path, body) => api.request(path, { method: "POST", body }),
    });
    SendQueue.open({ storage: AsyncStorage, send }).then((opened) => {
      if (!alive) return;
      unsubscribe = opened.subscribe((next) => {
        setItems(next);
        setPaused(opened.isPaused());
      });
      setItems(opened.items());
      setQueue(opened);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    if (!queue) return;
    queue.setPaused(status !== "signedIn");
    setPaused(queue.isPaused());
  }, [queue, status]);

  useEffect(() => {
    if (!queue) return;
    return NetInfo.addEventListener((state) => {
      // unknown reachability counts as online; a failed send tells the truth
      const isOnline = state.isConnected !== false && state.isInternetReachable !== false;
      queue.setOnline(isOnline);
      setOnline(isOnline);
    });
  }, [queue]);

  const value = useMemo<QueueValue>(
    () => ({
      ready: queue !== null,
      items,
      online,
      paused,
      enqueue: async (input) => {
        if (!queue) throw new Error("queue not ready");
        await queue.enqueue(input);
      },
      retryNow: () => {
        queue?.setPaused(status !== "signedIn");
        queue?.retryNow();
      },
      discard: async (clientUuid) => {
        await queue?.discard(clientUuid);
      },
      pendingFor: (stepId) => items.some((item) => item.label.stepId === stepId && (item.status === "waiting" || item.status === "sending")),
    }),
    [queue, items, online, paused, status],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error("useQueue outside QueueProvider");
  return value;
}
