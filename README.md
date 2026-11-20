# Timbangan Registrasi

Registrasi truk untuk timbangan pabrik: portal partner, web internal, dan API. Proyek ini masih dalam pembangunan; yang ada sekarang adalah fondasinya.

## Yang sudah ada

- `apps/api`: API (Fastify, TypeScript, PostgreSQL). Migrasi database, login akun partner, login karyawan lewat portal perusahaan (SSO), penyalinan kontrak dari ERP (baca-saja), dan pencarian kontrak.
- `apps/web`: web (Next.js). Halaman masuk, kerangka menu, dan halaman Kontrak.

Belum ada: registrasi truk, delivery order, master kendaraan dan supir, timbangan, aplikasi mobile, dan aplikasi timbang desktop.

## Menjalankan di komputer sendiri

Perlu Node.js 24 dan PostgreSQL 16 atau lebih baru.

```powershell
# API
cd apps/api
npm install
copy .env.example .env      # isi DATABASE_URL dan JWT_SECRET; bagian lain boleh kosong dulu
npm run migrate
$env:NEW_USER_PASSWORD = "<kata sandi admin>"
npm run user:create -- --username admin --full-name "Admin Sistem" --kind INTERNAL --role SUPER_ADMIN
npm run dev                  # http://localhost:3100

# Web, di terminal lain
cd apps/web
npm install
copy .env.example .env.local
npm run dev                  # http://localhost:3000
```

Tanpa PostgreSQL, API bisa dicoba dengan `DATABASE_URL=pglite://./.data/dev` (PostgreSQL di dalam proses Node).

Kontrak disalin dari ERP dengan `npm run sync:odoo` di `apps/api`, atau lewat tombol "Ambil dari Odoo" di halaman Kontrak, setelah bagian Odoo di `.env` diisi. Penyalinan hanya membaca.

## Uji

```powershell
cd apps/api; npm run typecheck; npm test
cd apps/web; npm run typecheck; npm run lint; npm test; npm run build
```

Uji API memakai database di memori dan server tiruan; tidak ada yang memanggil ERP atau portal yang asli. `npm run smoke` di `apps/web` menjalankan uji di browser terhadap API tiruan (perlu build dengan `NEXT_PUBLIC_API_URL=http://localhost:3110`).

## Catatan

- Kredensial hanya ada di berkas `.env`, yang tidak masuk repositori.
- Skema database ada di `apps/api/migrations`. Berkas migrasi yang sudah dijalankan tidak diedit; perubahan skema berarti berkas bernomor baru.
