// On the web the photo is a blob: or data: URL; the browser's FormData needs the bytes.

export async function photoFormData(uri: string): Promise<FormData> {
  const blob = await (await fetch(uri)).blob();
  const form = new FormData();
  form.append("file", blob, "foto.jpg");
  return form;
}
