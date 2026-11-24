// The spoken form: what the voice engine is given for one readable speech segment. Pure.
import { describe, expect, it } from "vitest";
import { numberWords, spokenForm } from "../src/speech/spoken.js";
import { FIXED_SENTENCES, messages } from "../src/weighing/messages.js";
import { normaliseSpeech } from "../src/weighing/speech.js";

describe("numberWords", () => {
  it("reads whole numbers in Indonesian", () => {
    expect(numberWords(0)).toBe("nol");
    expect(numberWords(7)).toBe("tujuh");
    expect(numberWords(10)).toBe("sepuluh");
    expect(numberWords(11)).toBe("sebelas");
    expect(numberWords(15)).toBe("lima belas");
    expect(numberWords(20)).toBe("dua puluh");
    expect(numberWords(99)).toBe("sembilan puluh sembilan");
    expect(numberWords(100)).toBe("seratus");
    expect(numberWords(110)).toBe("seratus sepuluh");
    expect(numberWords(250)).toBe("dua ratus lima puluh");
    expect(numberWords(1_000)).toBe("seribu");
    expect(numberWords(1_001)).toBe("seribu satu");
    expect(numberWords(1_500)).toBe("seribu lima ratus");
    expect(numberWords(12_048)).toBe("dua belas ribu empat puluh delapan");
    expect(numberWords(40_200)).toBe("empat puluh ribu dua ratus");
    expect(numberWords(100_000)).toBe("seratus ribu");
    expect(numberWords(111_111)).toBe("seratus sebelas ribu seratus sebelas");
    expect(numberWords(1_000_000)).toBe("satu juta");
    expect(numberWords(1_250_000)).toBe("satu juta dua ratus lima puluh ribu");
    expect(numberWords(2_001_000)).toBe("dua juta seribu");
    expect(numberWords(3_000_000_000)).toBe("tiga miliar");
  });
});

describe("spokenForm", () => {
  it("reads the numbers the plant writes: dot for thousands, comma for decimals, a leading minus", () => {
    expect(spokenForm("Berat 40.200 kilogram.")).toBe("Berat empat puluh ribu dua ratus kilogram.");
    expect(spokenForm("1.000")).toBe("seribu");
    expect(spokenForm("100")).toBe("seratus");
    expect(spokenForm("11")).toBe("sebelas");
    expect(spokenForm("12.048")).toBe("dua belas ribu empat puluh delapan");
    expect(spokenForm("1.250.000")).toBe("satu juta dua ratus lima puluh ribu");
    expect(spokenForm("0")).toBe("nol");
    expect(spokenForm("1,22")).toBe("satu koma dua dua");
    expect(spokenForm("Selisih -1.500 kilogram.")).toBe("Selisih minus seribu lima ratus kilogram.");
    expect(spokenForm("Toleransi 0,2 persen.")).toBe("Toleransi nol koma dua persen.");
    // a comma between words stays a pause, not a decimal
    expect(spokenForm("Timbang 41.500 kilogram, surat 40.200 kilogram.")).toBe("Timbang empat puluh satu ribu lima ratus kilogram, surat empat puluh ribu dua ratus kilogram.");
  });

  it("spells a plate with letter names and a pause between characters, like the chosen sample", () => {
    expect(spokenForm("Truk B K delapan tujuh sembilan nol V B. Silakan maju ke timbangan.")).toBe(
      "Truk be ka, delapan, tujuh, sembilan, nol, fe be. Silakan maju ke timbangan.",
    );
    expect(spokenForm("Plat B satu dua tiga empat X Y Z.")).toBe("Plat be, satu, dua, tiga, empat, eks ye zet.");
    expect(spokenForm("A B C D E F G H I J K L M N O P Q R S T U V W X Y Z")).toBe("a be ce de e ef ge ha i je ka el em en o pe ki er es te u fe we eks ye zet");
  });

  it("leaves digit words, written-out abbreviations and plain sentences alone", () => {
    expect(spokenForm("Sisa dua kali.")).toBe("Sisa dua kali.");
    expect(spokenForm("Berikutnya: kiu si pass.")).toBe("Berikutnya: kiu si pass.");
    expect(spokenForm("Nomor di o dan es pe je.")).toBe("Nomor di o dan es pe je.");
    expect(spokenForm("Mohon tunggu keputusan atasan.")).toBe("Mohon tunggu keputusan atasan.");
    // already spoken: a second pass changes nothing
    const once = spokenForm("Plat B K delapan V B. Bruto 40.200 kilogram.");
    expect(spokenForm(once)).toBe(once);
  });

  it("writes out abbreviations that reach it unconverted", () => {
    expect(spokenForm("Bruto 40.200 kg.")).toBe("Bruto empat puluh ribu dua ratus kilogram.");
    expect(spokenForm("Silakan menuju QC.")).toBe("Silakan menuju kiu si.");
  });
});

describe("spoken form of the real weighbridge sentences", () => {
  const spoken = (segments: string[]) => segments.map(spokenForm);

  it("card lookup with a plate", () => {
    expect(spoken(messages.card("BK 8790 VB", 1, "GROSS").speech)).toEqual(["Plat be ka, delapan, tujuh, sembilan, nol, fe be.", "Timbang pertama, bruto.", "Tunggu berat stabil."]);
  });

  it("weight saved, second weighing with netto and the next step", () => {
    expect(spoken(messages.saved({ stage: 2, kind: "TARE", weightKg: 12_048, netKg: 31_001, next: "QC pass" }).speech)).toEqual([
      "Timbang kedua berhasil.",
      "Tarra dua belas ribu empat puluh delapan kilogram.",
      "Netto tiga puluh satu ribu satu kilogram.",
      "Berikutnya: kiu si pass.",
    ]);
  });

  it("gross difference waiting for a decision, with two weights", () => {
    expect(spoken(messages.pending.GROSS_IN(41_500, 40_200).speech)).toEqual([
      "Selisih bruto melewati toleransi.",
      "Timbang empat puluh satu ribu lima ratus kilogram, surat empat puluh ribu dua ratus kilogram.",
      "Mohon tunggu keputusan atasan.",
    ]);
  });

  it("a difference given in percent", () => {
    expect(spokenForm(normaliseSpeech("Selisih 1.300 kg atau 3,25%."))).toBe("Selisih seribu tiga ratus kilogram atau tiga koma dua lima persen.");
  });

  it("plate mismatch", () => {
    expect(spoken(messages.pending.PLATE("BK 8790 VD", "BK 8790 VB").speech)).toEqual([
      "Plat tidak sesuai.",
      "Terbaca be ka, delapan, tujuh, sembilan, nol, fe de.",
      "Terdaftar be ka, delapan, tujuh, sembilan, nol, fe be.",
      "Mohon tunggu keputusan atasan.",
    ]);
  });

  it("PIN wrong with attempts left, card unknown, rejection", () => {
    expect(spoken(messages.pinWrong(2).speech)).toEqual(["pin salah.", "Sisa dua kali."]);
    expect(spoken(messages.cardUnknown().speech)).toEqual(["Kartu tidak dikenal."]);
    expect(spoken(messages.rejected(true).speech)).toEqual(["Permintaan ditolak.", "Supir ke pos registrasi."]);
  });

  it("every fixed sentence passes through unchanged (none has a number or a lone capital)", () => {
    for (const sentence of FIXED_SENTENCES) expect(spokenForm(sentence)).toBe(sentence);
  });
});
