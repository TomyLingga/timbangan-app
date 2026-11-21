import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { decisionErrorMessage, errorMessage, formRefusalMessage, loginErrorMessage } from "./messages";

describe("messages", () => {
  it("names network, timeout and server trouble plainly", () => {
    expect(errorMessage(new ApiError(0, "NETWORK_ERROR", "x"))).toBe("Tidak ada sinyal ke server. Coba lagi saat sinyal ada.");
    expect(errorMessage(new ApiError(0, "TIMEOUT", "x"))).toBe("Server terlalu lama menjawab. Coba lagi.");
    expect(errorMessage(new ApiError(502, "HTTP_502", "x"))).toContain("502");
    expect(errorMessage(new Error("boom"))).toBe("Terjadi kesalahan. Coba lagi.");
  });

  it("uses the login wording", () => {
    expect(loginErrorMessage(new ApiError(401, "INVALID_CREDENTIALS", "x"))).toBe("Username atau password salah.");
  });

  it("shows the API's field messages and 409 sentences for a refused form", () => {
    const error = new ApiError(400, "VALIDATION", "Data yang dikirim tidak valid.", { "values.FFA": "FFA harus antara 0 dan 20." });
    expect(formRefusalMessage(error)).toBe("FFA harus antara 0 dan 20.");
    expect(formRefusalMessage(new ApiError(409, "NOT_READY", "Langkah ini menunggu keputusan QC."))).toBe("Langkah ini menunggu keputusan QC.");
  });

  it("explains decision refusals", () => {
    expect(decisionErrorMessage(new ApiError(409, "ALREADY_DECIDED", "x"))).toBe("Permintaan ini sudah diputuskan orang lain.");
    expect(decisionErrorMessage(new ApiError(400, "VALIDATION", "x", { reason: "Alasan wajib diisi, minimal 3 huruf." }))).toBe(
      "Alasan wajib diisi, minimal 3 huruf.",
    );
  });
});
