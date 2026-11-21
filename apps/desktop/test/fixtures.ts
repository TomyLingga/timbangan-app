// Answers in the shape of the weighbridge routes, for the unit tests.
import type { CardAnswer, HeartbeatAnswer, TripView, WeighAnswer, WeighingView } from "../src/shared/api-types";

export const trip = (patch: Partial<TripView> = {}): TripView => ({
  id: 7,
  tripNo: "TRP-0007",
  status: "CHECKED_IN",
  direction: "IN",
  currentStep: "WEIGH_1",
  plateNo: "XX1234AB",
  plateDisplay: "XX 1234 AB",
  driverName: "Supir Contoh",
  partner: { id: 1, name: "Pemasok Contoh" },
  transporter: null,
  grossKg: null,
  tareKg: null,
  netKg: null,
  ...patch,
});

export const cardAnswer = (patch: Partial<CardAnswer> = {}): CardAnswer => ({
  trip: trip(),
  stage: 1,
  kind: "GROSS",
  camera: 3,
  expected: { plateNo: "XX1234AB", plateDisplay: "XX 1234 AB", docGrossKg: 41_000, docTareKg: 10_000, docNetKg: 31_000, vehicleTareKg: null },
  message: "Plat XX 1234 AB. Timbang pertama, bruto. Tunggu berat stabil.",
  speech: ["Plat X X satu dua tiga empat A B.", "Timbang pertama, bruto.", "Tunggu berat stabil."],
  ...patch,
});

export const weighing = (weightKg: number, patch: Partial<WeighingView> = {}): WeighingView => ({
  id: 11,
  stage: 1,
  kind: "GROSS",
  weightKg,
  weighedAt: "2026-11-21T08:00:00.000Z",
  mode: "AUTO",
  plateRead: "XX1234AB",
  plateCheck: "MATCH",
  status: "VALID",
  ...patch,
});

export const savedAnswer = (weightKg: number): WeighAnswer => ({
  result: "SAVED",
  weighing: weighing(weightKg),
  trip: trip({ status: "IN_PROCESS", grossKg: weightKg, currentStep: "QC" }),
  message: `Timbang pertama berhasil. Bruto ${weightKg} kg.`,
  speech: ["Timbang pertama berhasil.", `Bruto ${weightKg} kilogram.`],
});

export const pendingAnswer = (id = 5, type: "GROSS_IN" | "PLATE" = "GROSS_IN"): WeighAnswer => ({
  result: "PENDING",
  exception: { id, type },
  message: "Selisih bruto melewati toleransi. Mohon tunggu keputusan atasan.",
  speech: ["Selisih bruto melewati toleransi.", "Mohon tunggu keputusan atasan."],
});

export const plateRetryAnswer = (attemptsLeft: number): WeighAnswer => ({
  result: "PLATE_RETRY",
  attemptsLeft,
  message: "Plat belum terbaca sesuai. Coba baca plat lagi.",
  speech: ["Plat belum terbaca sesuai.", "Coba baca plat lagi."],
});

export const stillPending: HeartbeatAnswer = { status: "PENDING", message: "Mohon tunggu keputusan atasan.", speech: ["Mohon tunggu keputusan atasan."] };
