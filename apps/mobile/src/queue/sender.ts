// What the queue does to send one form: upload the photos that have no id yet (POST /api/files), then post the
// form with every photo id. A photo id is reported back at once, so a retry after a failure skips that upload.

import type { Sender } from "./queue";

export interface FormSenderDeps {
  /** Uploads one local image and answers its file id. */
  upload(uri: string): Promise<number>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
}

export function createFormSender(deps: FormSenderDeps): Sender {
  return async (item, onPhoto) => {
    const ids: number[] = [];
    for (const [index, photo] of item.photos.entries()) {
      if (photo.fileId !== null) {
        ids.push(photo.fileId);
        continue;
      }
      const fileId = await deps.upload(photo.uri);
      onPhoto(index, fileId);
      ids.push(fileId);
    }
    await deps.post(item.path, ids.length > 0 ? { ...item.body, photoFileIds: ids } : item.body);
  };
}
