// The four plate cameras of the reader service, polled once a second: the latest text and status of each. A reader
// that does not answer counts as offline. Pure.

export const CAMERA_COUNT = 4;

export type CameraStatus = "unknown" | "online" | "lagging" | "offline" | "unreachable";

export interface CameraReading {
  camera: number;
  plate: string | null;
  status: CameraStatus;
  at: number | null;
}

const LABELS = ["Outgoing · timbang 1", "Outgoing · timbang 2", "Incoming · timbang 1", "Incoming · timbang 2"];

/** Cameras 1 to 4 as the plant names them: direction and weighing stage. */
export const cameraLabel = (camera: number): string => LABELS[camera - 1] ?? `Kamera ${camera}`;

export const initialCameras = (): CameraReading[] => Array.from({ length: CAMERA_COUNT }, (_, index) => ({ camera: index + 1, plate: null, status: "unknown", at: null }));

const knownStatus = (status: string): CameraStatus => (status === "online" || status === "lagging" || status === "offline" ? status : "offline");

/** Records one answer of GET /plate/{camera}; null means the reader did not answer. */
export function recordCamera(state: CameraReading[], camera: number, read: { plate: string; status: string } | null, now: number): CameraReading[] {
  if (camera < 1 || camera > CAMERA_COUNT) return state;
  const next: CameraReading = read ? { camera, plate: read.plate.trim() || null, status: knownStatus(read.status), at: now } : { camera, plate: null, status: "unreachable", at: now };
  return state.map((reading) => (reading.camera === camera ? next : reading));
}

/** Cameras that give readings now: online, or online but slow. */
export const onlineCount = (state: CameraReading[]): number => state.filter((reading) => reading.status === "online" || reading.status === "lagging").length;
