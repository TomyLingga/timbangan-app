# apps/web

Web registrasi timbangan: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, `motion`. Halaman yang ada: `/login`, `/auth/sso`, Beranda (`/`), `/kontrak`, `/supir`, `/kendaraan`, `/tujuan`, `/pengguna`, dan halaman Fase 3: `/registrasi` (daftar, rincian, `/registrasi/<id>/ubah` untuk draf, `/registrasi/baru?arah=in`, `/registrasi/baru?arah=out&do=<id>`), `/delivery-order` (daftar dan rincian dengan truknya), `/pos`, `/kartu`, dan `/spj/<tripId>/cetak` (tanpa menu, untuk dicetak atau disimpan sebagai PDF). Barcode SPJ (QR dan Code 128) digambar di browser dengan `bwip-js`.

## Hak akses

Hak akses per modul, bukan per peran (`docs/rancangan-hak-akses.md`). `GET /api/me` membawa `permissions` (kode modul ke `VIEW`, `CREATE`, atau `EDIT`; tingkat yang lebih tinggi mencakup yang di bawahnya). `src/lib/permissions.ts` memuat pemeriksaannya: menu tampil mulai tingkat lihat, tombol tambah mulai tingkat buat, tombol ubah dan tindakan lain mulai tingkat ubah, mengikuti tabel rute di `apps/api/test/route-permissions.test.ts`. Halaman modul yang tidak boleh dibuka menampilkan "Anda tidak punya akses ke halaman ini"; akun karyawan tanpa hak akses sama sekali melihat halaman "Menunggu hak akses". Hak akses diatur di `/pengguna`.

## Menjalankan

Butuh Node 24. Alamat API dibaca dari `NEXT_PUBLIC_API_URL` saat build (lihat `.env.example`); tanpa variabel itu yang dipakai `http://localhost:3100`.

```bash
npm install
npm run mock:api      # API tiruan di http://localhost:3100
npm run dev           # web di http://localhost:3000
```

Pemeriksaan:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## API tiruan

`dev/mock-api.mjs` meniru kontrak API tanpa dependensi. Semua nama, perusahaan, dan nomor kontrak di dalamnya karangan.

- Akun partner (kata sandi `contoh-123`): `pks.contoh.a` (pemasok), `transporter.contoh`; hak aksesnya bawaan partner menurut jenis perusahaannya.
- Akun karyawan masuk lewat `http://localhost:3100/api/auth/sso/start?as=admin.contoh` (semua modul tingkat ubah kecuali Pengguna). Rute itu berperan sebagai portal: browser dikembalikan ke `/?token=…&appId=…` (tambahkan `&to=callback` untuk `/auth/sso`). Akun lain: `super.contoh` (semua modul), `pos.contoh` (pos registrasi, registrasi tingkat buat, kontrak tingkat lihat), `staf.baru` (belum punya hak akses).
- Akun untuk memisahkan dua modul keputusan: `manajer.qc` (hanya Keputusan QC tingkat ubah), `pengawas.timbang` (Keputusan selisih dan plat tingkat ubah, Keputusan QC tingkat lihat), `keputusan.timbang` (hanya Keputusan selisih dan plat tingkat ubah). Seperti API asli, daftar Keputusan hanya memuat jenis permintaan dari modul yang dipegang akun.
- `petugas.lokal` (kata sandi `contoh-123`) meniru akun darurat lokal (`npm run user:create -- --admin`): karyawan dengan semua modul tingkat ubah yang masuk dengan kata sandi.
- Rute, kode galat, dan bentuk jawaban mengikuti API asli (`docs/fase-3-penyelarasan.md`), termasuk tiga rute `lookup` untuk form registrasi, `GET /api/admin/modules`, dan `PUT /api/admin/users/:id/permissions`.
- Supir baru dari form berstatus "menunggu dikirim ke VCF" dan terkirim saat "Ambil dari VCF". Satu supir contoh selalu gagal dikirim, supaya tanda gagal dan alasannya bisa dilihat.
- Fase 3: supir `CONTOH0004` berstatus blacklist, `CONTOH0003` warning; kartu `04A1B2C301` sampai `04A1B2C305` tersedia.
- `MOCK_FLOW=sample` mengisi truk di semua tahap pabrik (akan datang, di dalam pabrik per langkah, selesai hari ini) untuk melihat Aliran truk di Beranda; `MOCK_FLOW=empty` menghapus truk contoh bawaan. Tanpa variabel itu data tidak berubah.
- `MOCK_ODOO=off` membuat sinkron menjawab 503, `MOCK_SSO=off` membuat penukaran tiket menjawab 503, `MOCK_VCF=off` atau `MOCK_VCF=fail` membuat ambil dari VCF menjawab 503 atau 502.

## Uji asap di browser

`dev/smoke.mjs` menjalankan API tiruan (port 3110), `next start` (port 3210), dan Edge atau Chrome tanpa jendela, lalu memeriksa alur masuk, daftar kontrak, sinkron, data master, tampilan ponsel, hak akses (halaman menunggu hak akses, pengaturan tingkat per modul di `/pengguna` dan menu yang ikut berubah, tingkat lihat tanpa tombol tambah dan ubah, modul terlarang untuk akun partner), dan alur Fase 3: registrasi incoming dengan dua kontrak sampai SPJ, draf yang diubah lalu dikirim, DO yang dikirim lalu diisi empat truk, tinjauan admin, rincian DO, halaman cetak SPJ, dan check-in di pos. Build harus menunjuk ke port API tiruan itu:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
npm run smoke
```

`SMOKE_MODE=dev npm run smoke` memakai `next dev` (tanpa build), sehingga React Strict Mode ikut teruji. Tangkapan layar ditulis ke `dev/.smoke/`.

`node dev/ui-shots.mjs [folder]` memakai build dan port yang sama untuk memotret halaman utama dalam tema gelap dan terang, lebar 1440 dan 390 piksel. Skrip itu menjalankan API tiruan dua kali: dengan `MOCK_FLOW=sample` untuk semua halaman, lalu dengan `MOCK_FLOW=empty` untuk Beranda tanpa truk. Folder bawaannya `.data/ui-pilot` di akar repo.

## Uji browser terhadap API asli

`dev/e2e-real.mjs` menjalankan alur pokok terhadap API asli di database pengembangan: masuk, lihat kontrak, registrasi incoming dua kontrak, halaman cetak SPJ dengan kedua barcode, check-in di pos dengan kartu uji, lalu membatalkan trip itu dan memastikan kartunya bebas lagi. Kendaraan uji (plat `ZZ … E2E`) dan kartu uji (UID berawalan `E2E0`) dibuat sendiri lewat API; supir dipilih dari yang sudah ada, jadi tidak ada yang dikirim ke VCF. Di akhir kartu uji dibuat `RETIRED` dan kendaraan uji dinonaktifkan. Alamat dan akun hanya dibaca dari variabel lingkungan dan tidak dicetak:

```bash
NEXT_PUBLIC_API_URL=<alamat API> npm run build
E2E_API_URL=<alamat API> E2E_USERNAME=<akun lokal> E2E_PASSWORD=<kata sandi> node dev/e2e-real.mjs
```

Akun itu harus akun karyawan dengan kata sandi dan hak akses yang disebut di kepala skrip. `next start` berjalan di port `E2E_WEB_PORT` (bawaan 3220); API harus menerima origin itu. Uji ini tidak ikut `npm test`.
