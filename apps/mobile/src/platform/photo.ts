// Taking a photo for a form: the camera on the phone (gallery as a second way), then the long side shrunk to
// 1,600 px and saved as JPEG before it goes into the form and the send queue.

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import type { Photo } from "../forms/shared";
import { JPEG_QUALITY, resizeTarget } from "../photos/resize";

export type PhotoResult = { ok: true; photo: Photo } | { ok: false; message: string | null };

async function shrink(uri: string, width: number, height: number): Promise<Photo> {
  const context = ImageManipulator.manipulate(uri);
  const target = resizeTarget(width, height);
  if (target) context.resize(target);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

export async function takePhoto(source: "camera" | "gallery"): Promise<PhotoResult> {
  try {
    const useCamera = source === "camera" && Platform.OS !== "web";
    if (useCamera) {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return { ok: false, message: "Izin kamera ditolak. Buka pengaturan ponsel untuk mengizinkan." };
    }
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsEditing: false };
    const result = useCamera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    if (result.canceled) return { ok: false, message: null };
    const asset = result.assets[0];
    if (!asset) return { ok: false, message: null };
    return { ok: true, photo: await shrink(asset.uri, asset.width, asset.height) };
  } catch {
    return { ok: false, message: "Foto tidak bisa diambil. Coba lagi." };
  }
}
