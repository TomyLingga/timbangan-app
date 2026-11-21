// The multipart body of POST /api/files for a local JPEG. React Native's FormData takes { uri, name, type }.

export async function photoFormData(uri: string): Promise<FormData> {
  const form = new FormData();
  form.append("file", { uri, name: "foto.jpg", type: "image/jpeg" } as unknown as Blob);
  return form;
}
