import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "./queue";
import { createFormSender } from "./sender";

const item = (photos: QueueItem["photos"]): QueueItem => ({
  clientUuid: "00000000-0000-4000-8000-000000000001",
  path: "/api/work/steps/5/unloading",
  body: { clientUuid: "00000000-0000-4000-8000-000000000001", tankId: 3 },
  photos,
  label: { form: "Bongkar", plate: "ZZ 0001 CTH", stepId: 5, stepName: "Bongkar" },
  values: {},
  status: "sending",
  attempts: 0,
  createdAt: "2026-11-21T07:00:00.000Z",
  nextAttemptAt: null,
  lastError: null,
  sentAt: null,
});

describe("form sender", () => {
  it("uploads photos that have no id yet, then posts the form with all photo ids", async () => {
    const upload = vi.fn(async (uri: string) => (uri.endsWith("b.jpg") ? 22 : 99));
    const post = vi.fn(async () => ({ step: null }));
    const onPhoto = vi.fn();
    const send = createFormSender({ upload, post });
    await send(item([{ uri: "file:///a.jpg", fileId: 11 }, { uri: "file:///b.jpg", fileId: null }]), onPhoto);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(onPhoto).toHaveBeenCalledWith(1, 22);
    expect(post).toHaveBeenCalledWith("/api/work/steps/5/unloading", {
      clientUuid: "00000000-0000-4000-8000-000000000001",
      tankId: 3,
      photoFileIds: [11, 22],
    });
  });

  it("posts the body as it is when the form has no photos", async () => {
    const post = vi.fn(async () => ({}));
    await createFormSender({ upload: vi.fn(), post })(item([]), vi.fn());
    expect(post).toHaveBeenCalledWith("/api/work/steps/5/unloading", { clientUuid: "00000000-0000-4000-8000-000000000001", tankId: 3 });
  });
});
