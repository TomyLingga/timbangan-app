import { describe, expect, it } from "vitest";
import { stationWebPreferences } from "../src/main/window-options";

describe("station window preferences", () => {
  it("keep the page sandboxed and isolated, with the given preload", () => {
    const preferences = stationWebPreferences("C:/program/preload/index.js");
    expect(preferences).toMatchObject({ preload: "C:/program/preload/index.js", contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
  });

  it("let the window speak before anyone clicks or types in it", () => {
    // Chromium's own default (document-user-activation-required) leaves the AudioContext suspended; see
    // `npm run speech:check -- --autoplay-policy document-user-activation-required`
    expect(stationWebPreferences("preload.js").autoplayPolicy).toBe("no-user-gesture-required");
  });
});
