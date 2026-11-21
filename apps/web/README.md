# apps/web

Web registrasi timbangan: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, `motion`. Halaman yang ada: `/login`, `/auth/sso`, Beranda (`/`), `/kontrak`, `/supir`, `/kendaraan`, `/tujuan`, `/pengguna` (hanya admin sistem), dan halaman Fase 3: `/registrasi` (daftar, rincian, `/registrasi/baru?arah=in`, `/registrasi/baru?arah=out&do=<id>`), `/delivery-order`, `/pos`, `/kartu`, dan `/spj/<tripId>/cetak` (tanpa menu, untuk dicetak atau disimpan sebagai PDF). Barcode SPJ (QR dan Code 128) digambar di browser dengan `bwip-js`.

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

- Akun partner (kata sandi `contoh-123`): `pks.contoh.a`, `transporter.contoh`.
- Akun karyawan masuk lewat `http://localhost:3100/api/auth/sso/start?as=admin.contoh`. Rute itu berperan sebagai portal: browser dikembalikan ke `/?token=…&appId=…` (tambahkan `&to=callback` untuk `/auth/sso`). Akun lain: `super.contoh` (admin sistem, satu-satunya yang membuka `/pengguna`), `pos.contoh` (tanpa tombol ambil dari Odoo), `staf.baru` (belum punya peran).
- Supir baru dari form berstatus "menunggu dikirim ke VCF" dan terkirim saat "Ambil dari VCF". Satu supir contoh selalu gagal dikirim, supaya tanda gagal dan alasannya bisa dilihat.
- Fase 3: kartu RFID, DO, registrasi, trip, SPJ, dan pos registrasi mengikuti bagian 3 `docs/fase-3-rancangan.md`. Rute yang dibutuhkan form tetapi belum ada di rancangan (`GET /api/quality-parameters`, `GET /api/products`, pencarian supir, kendaraan, dan transporter oleh akun partner) ditandai "not in the contract" di kode. Supir `CONTOH0004` berstatus blacklist, `CONTOH0003` warning; kartu `04A1B2C301` sampai `04A1B2C305` tersedia.
- `MOCK_ODOO=off` membuat sinkron menjawab 503, `MOCK_SSO=off` membuat penukaran tiket menjawab 503, `MOCK_VCF=off` atau `MOCK_VCF=fail` membuat ambil dari VCF menjawab 503 atau 502.

## Uji asap di browser

`dev/smoke.mjs` menjalankan API tiruan (port 3110), `next start` (port 3210), dan Edge atau Chrome tanpa jendela, lalu memeriksa alur masuk, daftar kontrak, sinkron, data master, tampilan ponsel, dan alur Fase 3: registrasi incoming dengan dua kontrak sampai SPJ, DO yang dikirim lalu diisi empat truk, tinjauan admin, halaman cetak SPJ, dan check-in di pos. Build harus menunjuk ke port API tiruan itu:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
npm run smoke
```

`SMOKE_MODE=dev npm run smoke` memakai `next dev` (tanpa build), sehingga React Strict Mode ikut teruji. Tangkapan layar ditulis ke `dev/.smoke/`.
