// CCTV snapshots for the screen. The window loads no remote content, so the main process fetches each JPEG and
// hands the bytes over; a failed fetch shows an empty frame.

export function createCctvPoller(options: { urls: string[]; everyMs?: number; onFrame(index: number, jpeg: Uint8Array | null): void; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  let timer: ReturnType<typeof setInterval> | null = null;
  const busy = new Set<number>();

  const poll = () => {
    options.urls.forEach((url, index) => {
      if (busy.has(index)) return;
      busy.add(index);
      fetcher(url, { signal: AbortSignal.timeout(2_000) })
        .then(async (response) => {
          const type = response.headers.get("content-type") ?? "";
          options.onFrame(index, response.ok && type.startsWith("image/") ? new Uint8Array(await response.arrayBuffer()) : null);
        })
        .catch(() => options.onFrame(index, null))
        .finally(() => busy.delete(index));
    });
  };

  return {
    start() {
      if (options.urls.length === 0) return;
      poll();
      timer = setInterval(poll, options.everyMs ?? 1_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
