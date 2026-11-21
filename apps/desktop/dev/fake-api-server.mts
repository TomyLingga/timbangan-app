// Runs the fake weighbridge API and plate reader on this computer, for developing the program without the real
// API: `npm run fake-api`. The key and PIN below exist only for this fake.
import { readFileSync } from "node:fs";
import { startFakeApi } from "./fake-api.ts";

export const DEV_STATION_KEY = "st1.development-only-key-for-the-fake-api-000000000";

const port = Number(process.env.FAKE_API_PORT ?? 4010);
const api = await startFakeApi({
  port,
  stationKey: DEV_STATION_KEY,
  pin: "1234",
  plateAttempts: 3,
  cameraWeigh1: 3,
  cameraWeigh2: 4,
  speech: process.env.FAKE_SPEECH === "off" ? "off" : "tone",
  // the supervisor "decides" after three heartbeats, so the waiting screen can be seen without the approvals app
  autoDecide: { afterHeartbeats: Number(process.env.FAKE_DECIDE_AFTER ?? 3), decision: "APPROVE" },
  devControl: true,
  // drawn test pictures standing in for the two CCTV snapshots
  cctvImages: { 1: readFileSync(new URL("./cctv-sample-1.jpg", import.meta.url)), 2: readFileSync(new URL("./cctv-sample-2.jpg", import.meta.url)) },
  plates: { 3: "XX1234AB", 4: "XX1234AB" },
  trucks: [
    { cardUid: "0A1B2C3D4E", tripId: 1, tripNo: "IN-0001", direction: "IN", plateNo: "XX1234AB", plateDisplay: "XX 1234 AB", driverName: "Supir Satu", partnerName: "Pemasok Contoh", stage: 1 },
    { cardUid: "1A2B3C4D5E", tripId: 2, tripNo: "IN-0002", direction: "IN", plateNo: "YY5678CD", plateDisplay: "YY 5678 CD", driverName: "Supir Dua", partnerName: "Pemasok Contoh", stage: 1, check: "GROSS_IN" },
    { cardUid: "2A3B4C5D6E", tripId: 3, tripNo: "OUT-0003", direction: "OUT", plateNo: "ZZ9012EF", plateDisplay: "ZZ 9012 EF", driverName: "Supir Tiga", partnerName: "Pembeli Contoh", stage: 1, waitingStep: { code: "QC", name: "QC" } },
  ],
});
console.log(`fake weighbridge API and plate reader on ${api.url}`);
console.log("cards: 0A1B2C3D4E saved at once, 1A2B3C4D5E asks for a decision, 2A3B4C5D6E not ready, anything else unknown");
