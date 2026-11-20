# apps/web

Web registrasi timbangan: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui, `motion`. Halaman yang ada: `/login`, `/auth/sso`, Beranda (`/`), dan `/kontrak`.

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
- Akun karyawan masuk lewat `http://localhost:3100/api/auth/sso/start?as=admin.contoh`. Rute itu berperan sebagai portal: browser dikembalikan ke `/?token=…&appId=…` (tambahkan `&to=callback` untuk `/auth/sso`). Akun lain: `pos.contoh` (tanpa tombol ambil dari Odoo), `staf.baru` (belum punya peran).
- `MOCK_ODOO=off` membuat sinkron menjawab 503, `MOCK_SSO=off` membuat penukaran tiket menjawab 503.

## Uji asap di browser

`dev/smoke.mjs` menjalankan API tiruan (port 3110), `next start` (port 3210), dan Edge atau Chrome tanpa jendela, lalu memeriksa alur masuk, daftar kontrak, sinkron, dan tampilan ponsel. Build harus menunjuk ke port API tiruan itu:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3110 npm run build
npm run smoke
```

`SMOKE_MODE=dev npm run smoke` memakai `next dev` (tanpa build), sehingga React Strict Mode ikut teruji. Tangkapan layar ditulis ke `dev/.smoke/`.
