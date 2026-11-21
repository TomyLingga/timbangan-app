# Aplikasi timbang (desktop)

Program di PC timbangan. Supir menempelkan kartu RFID, program membaca plat dari layanan pembaca plat dan berat dari indikator timbangan, mengirim timbang ke API, lalu memberi tahu supir lewat layar dan suara. Program berjalan tanpa operator.

Electron 45 dengan React 19 dan TypeScript. Proses utama memegang timbangan, jaringan, pengaturan, dan log. Jendela hanya menampilkan dan memutar suara, lewat jembatan sempit di `src/preload` (`contextIsolation` aktif, `nodeIntegration` mati, sandbox aktif, tidak memuat apa pun dari jaringan, Content Security Policy ketat).

## Menjalankan untuk pengembangan

Perlu Node 24.

```sh
npm ci
npm run fake-api     # terminal 1: API timbang tiruan dan pembaca plat tiruan di http://localhost:4010
npm run dev          # terminal 2: program dengan timbangan simulator
```

Pada jalan pertama belum ada kunci stasiun, jadi Pengaturan (F2) terbuka tanpa PIN. Isi:

- Alamat server dan alamat pembaca plat: `http://localhost:4010`
- Kunci stasiun: nilai `DEV_STATION_KEY` di `dev/fake-api-server.mts`
- Sambungan: Simulator

Kartu bisa "ditempel" dengan mengetik UID dengan cepat lalu Enter, seperti pembaca RFID. Kartu di API tiruan: `0A1B2C3D4E` langsung tersimpan, `1A2B3C4D5E` meminta keputusan (disetujui sendiri setelah tiga heartbeat), `2A3B4C5D6E` belum siap ditimbang, kartu lain tidak dikenal. PIN stasiun tiruan: `1234`.

Tombol simulator (hanya saat pengembangan): F6 menaikkan truk (41.500 kg), F7 menggeser berat 20 kg, F8 mengosongkan timbangan.

`npm run demo` menjalankan skenario otomatis terhadap API tiruan (timbang tersimpan, timbang yang menunggu keputusan, kartu tidak dikenal) lalu menutup diri. Bila `DESKTOP_CAPTURE_DIR` diisi, gambar jendela tiap keadaan layar disimpan ke folder itu.

Bila variabel lingkungan `ELECTRON_RUN_AS_NODE` terisi di terminal, Electron berjalan sebagai Node dan jendela tidak muncul. Kosongkan dulu.

## Perintah

```sh
npm run typecheck    # tsc untuk proses utama dan jendela
npm test             # Vitest: modul murni, klien API terhadap API tiruan, uji ujung ke ujung tanpa jendela
npm run build        # build produksi ke out/ (bukan installer)
npm start            # menjalankan hasil build
```

## Memakai API dan timbangan sungguhan

1. Di web, buat stasiun timbangan dan kuncinya di halaman Stasiun. Kunci hanya tampil sekali.
2. Atur PIN stasiun di halaman yang sama. PIN membuka Pengaturan dan mode ketik plat; API yang memeriksanya (`POST /api/weighbridge/manual-plate`), dan API mengunci PIN 5 menit setelah 5 kali salah.
3. Di program, buka Pengaturan (F2), isi alamat server, tempel kunci stasiun, isi alamat pembaca plat, lalu pilih sambungan timbangan.

## Arti pengaturan

| Isian | Arti |
|---|---|
| Alamat server | Alamat API, misalnya `https://api.contoh.test`. Program memanggil rute `/api/weighbridge/...` dengan kepala `X-Station-Key`. |
| Kunci stasiun | Kunci mesin dari halaman Stasiun. Disimpan terenkripsi dengan `safeStorage` Electron (DPAPI di Windows). Bila sistem tidak menyediakan enkripsi, disimpan sebagai berkas biasa dan Pengaturan menyebutkannya. Kunci tidak pernah dikirim ke jendela dan tidak ditulis ke log. |
| Alamat pembaca plat | Layanan pembaca plat. Program memanggil `GET {alamat}/plate/{kamera}` tiap detik selama ada truk; nomor kamera datang dari jawaban kartu (pengaturan stasiun di API). Kosong: plat dikirim kosong dan API memperlakukannya sebagai plat tidak terbaca. |
| Gambar CCTV 1 dan 2 | Alamat gambar JPEG, diambil proses utama tiap detik. Boleh kosong. |
| Sambungan | Jaringan (TCP), Serial (RS-232), atau Simulator. |
| Alamat indikator, Port | Untuk TCP. Program lama memakai port 3002. |
| Port serial, Baud rate, Data bit, Parity, Stop bit | Untuk RS-232. Bawaan sama dengan program lama: 2400 baud, 7 data bit, tanpa parity, 1 stop bit. |

Pengaturan disimpan di folder data pengguna Electron (`settings.json`, `station-key.bin`), bukan di folder ini. PIN stasiun tidak disimpan di PC.

## Aturan yang dipakai program

- Berat dibaca dari tiap baris indikator: angka pertama setelah penanda `99 `. Baris tanpa penanda diabaikan.
- Stabil: berat sama pada tiga bacaan berjarak 500 ms, lalu hitung mundur 3 detik. Berat berubah mengulang dari awal. Sepuluh kali berubah sebelum stabil memunculkan pemberitahuan "Berat belum stabil".
- Tiap percobaan timbang membawa `requestId` baru. Bila server tidak menjawab, percobaan yang sama dikirim ulang dengan `requestId` yang sama (sampai tiga kali), jadi tidak tercatat dua kali.
- Menunggu keputusan: berat dikirim tiap 2 detik. Berat di bawah 1.000 kg selama 5 detik membatalkan permintaan (`TRUCK_LEFT`).
- Kalimat di layar dan suara berasal dari API (`message` dan `speech`). Audio tiap potongan diambil dari `GET /api/weighbridge/speech`; bila API menjawab 204 atau gagal, teks tetap tampil dan program membunyikan nada pendek.

## Log

Satu berkas per hari di folder `logs` dalam folder data pengguna: tiap bacaan stabil, tiap panggilan API dengan status dan lamanya, perubahan layar, dan galat. Kunci stasiun dan PIN ditulis sebagai `[hidden]`.
