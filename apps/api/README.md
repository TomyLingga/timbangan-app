# API

Cara menjalankan dan menguji ada di README di akar repositori. Berkas ini mencatat suara timbangan.

## Suara timbangan (TTS)

Setiap jawaban rute `/api/weighbridge/*` membawa `message` (untuk layar) dan `speech` (segmen yang diucapkan). Program timbangan mengambil audio tiap segmen dari `GET /api/weighbridge/speech?text=...`. Jawabannya WAV 16-bit mono 44,1 kHz, atau 204 bila suara mati atau sintesis gagal; dengan 204 program menampilkan teks dan berbunyi "tit".

`speech[]` tetap teks yang bisa dibaca ("Bruto 40.200 kilogram."). Sebelum dikirim ke mesin suara, teks itu diubah ke bentuk ucapan (`src/speech/spoken.ts`): angka menjadi kata ("empat puluh ribu dua ratus"), koma desimal dibaca "koma", huruf plat dibaca dengan nama hurufnya dan diberi jeda ("be ka, delapan, tujuh, sembilan, nol, fe be").

### Mesin

- `off` (bawaan): tanpa suara.
- `supertonic`: Supertonic 3 (int8, ekspor sherpa-onnx) lewat paket `sherpa-onnx-node`, berjalan di CPU mesin ini. Tidak ada layanan luar yang dipanggil.

### Model

Model diambil dari rilis `tts-models` proyek sherpa-onnx di GitHub (k2-fsa/sherpa-onnx). Nama asetnya `sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2` (sekitar 129 MB):

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2
```

Nama dan alamat itu dicek lewat daftar aset rilis di GitHub API, 24 November 2026; halaman dokumentasi TTS sherpa-onnx belum mencantumkan model ini.

Ekstrak arsipnya, lalu salin tujuh berkas ini ke satu folder, misalnya `apps/api/storage/tts/supertonic3/` (folder `storage/` tidak masuk git):

```
duration_predictor.int8.onnx  text_encoder.int8.onnx  vector_estimator.int8.onnx  vocoder.int8.onnx
tts.json  unicode_indexer.bin  voice.bin
```

Bila ada berkas yang hilang, API berhenti saat mulai dan menyebut nama berkasnya.

### Pengaturan di `.env`

```
TTS_ENGINE=supertonic
TTS_MODEL_DIR=storage/tts/supertonic3   # wajib bila supertonic
TTS_VOICE=F2                            # F1..F5, M1..M5; bawaan F2
TTS_SPEED=1.0                           # 0.5 sampai 2; bawaan 1.0
TTS_THREADS=4                           # thread CPU per sintesis; bawaan 4
```

Audio disimpan di `TTS_CACHE_DIR` (bawaan `.data/tts-cache`), satu folder per suara dan kecepatan, nama berkas dari hash SHA-256 bentuk ucapan. Restart tidak menghapusnya. Batasnya 500 MB; berkas yang paling lama tidak dipakai dihapus lebih dulu.

### Cara kerjanya

- Model dimuat sekali, saat sintesis pertama. Saat server mulai, kalimat tetap (`FIXED_SENTENCES`) dibuat di latar belakang, jadi model biasanya sudah termuat sebelum truk pertama.
- Satu sintesis pada satu waktu. Permintaan dari stasiun didahulukan dari pemanasan; teks yang sama yang diminta bersamaan memakai satu pekerjaan.
- Begitu rute timbangan menjawab dengan `speech`, segmen yang belum ada di cache langsung mulai dibuat, sehingga audio biasanya sudah siap saat program memintanya.
- Volume dinaikkan sampai puncak 0,89 (sekitar -1 dBFS), sebab keluaran model pelan.
- Sintesis yang gagal dijawab 204 dan dicatat di log sekali per teks. Jawaban timbangan tidak terpengaruh.

### Kecepatan dan memori

Diukur 24 November 2026 di laptop pengembangan (i7-14700HX, 4 thread), uji `test/speech-supertonic.test.ts`: segmen pertama 1,6 detik (termasuk memuat model), segmen berikutnya 0,5 sampai 1,4 detik untuk audio 1,4 sampai 7,2 detik, pengulangan dari cache 1 ms. RSS proses uji naik dari 78 MB menjadi sekitar 350 MB setelah model termuat. Pengukuran sebelumnya dengan skrip contoh (`synth_supertonic.js`): 1,1 sampai 4,0 detik per kalimat, 232 MB (puncak 420 MB). Belum diukur di PC timbangan.

### Uji dengan model asli

Uji ini dilewati kecuali `TTS_MODEL_DIR` ada di lingkungan perintah uji (bukan di `.env`):

```powershell
$env:TTS_MODEL_DIR = "storage/tts/supertonic3"; npx vitest run test/speech-supertonic.test.ts
```
