# Pemasangan di server dengan Docker

Panduan ini untuk orang yang memasang Timbangan Registrasi di server produksi. Semua perintah dijalankan di folder `deploy/` repositori ini, kecuali disebut lain.

Isi folder ini:

| Berkas | Fungsi |
|---|---|
| `docker-compose.yml` | Empat container: `db` (PostgreSQL 17), `api` (Fastify), `web` (Next.js), `proxy` (Caddy) |
| `Caddyfile` | Pengaturan Caddy: `/api/*` ke API, sisanya ke web |
| `.env.example` | Daftar variabel; disalin menjadi `.env` |
| `storage/` | Dibuat sendiri di server, tidak masuk git: model suara, berkas denah, hasil backup |

Hanya Caddy yang terbuka ke jaringan (port 80 dan 443). Database dan API tidak dipublikasikan ke host; API hanya dijangkau Caddy.

Server tidak memerlukan Node.js. Node 24 ada di dalam image API dan web.

## Prasyarat

- Server Linux x64 dengan Docker Engine dan plugin Compose v2. Periksa dengan `docker compose version`.
- `git`, untuk mengambil kode.
- Port 80 di server belum dipakai program lain. Untuk HTTPS juga port 443.
- Akses internet saat build: image dasar diunduh dari Docker Hub dan paket dari registry npm.

## Pemasangan pertama

1. Ambil kode, lalu masuk ke folder `deploy`:

   ```sh
   git clone <alamat repositori> /opt/timbangan-registrasi
   cd /opt/timbangan-registrasi/deploy
   ```

2. Buat berkas pengaturan dan batasi aksesnya:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Isi `.env`. Yang wajib:
   - `PUBLIC_URL`: alamat yang diketik pengguna, tanpa `/` di akhir dan tanpa `/api`, misalnya `http://timbangan.example.com`.
   - `POSTGRES_PASSWORD`: hanya huruf dan angka, sebab nilainya dimasukkan ke dalam `DATABASE_URL`. Buat dengan `openssl rand -hex 24`.
   - `JWT_SECRET`: minimal 32 karakter. Buat dengan `openssl rand -hex 32`.
   - `SITE_ADDRESS` dan `TLS_MODE`: lihat bagian [HTTPS](#https). Untuk percobaan pertama di LAN biarkan `:80` dan `auto`.

   Bagian Odoo, portal, VCF, dan suara boleh dikosongkan dulu. Tanpa bagian itu rute yang memerlukannya menjawab 503.

4. Buat folder untuk berkas yang tidak masuk git:

   ```sh
   mkdir -p storage/tts storage/plan storage/firebase storage/backups
   ```

   Bila notifikasi push dipakai (`PUSH_PROVIDER=fcm`), salin kunci service account proyek Firebase ke `deploy/storage/firebase/service-account.json`. Berkas ini rahasia dan tidak masuk git. Batasi aksesnya ke pengguna yang menjalankan API di dalam container (`node`, uid 1000):

   ```sh
   sudo chown 1000:1000 storage/firebase/service-account.json
   sudo chmod 600 storage/firebase/service-account.json
   ```

5. Bila suara timbangan dipakai (`TTS_ENGINE=supertonic`), salin tujuh berkas model Supertonic 3 (sekitar 139 MB) dari komputer pengembangan, folder `apps/api/storage/tts/supertonic3/`, langsung ke `deploy/storage/tts/` di server (tanpa subfolder):

   ```
   duration_predictor.int8.onnx  text_encoder.int8.onnx  vector_estimator.int8.onnx  vocoder.int8.onnx
   tts.json  unicode_indexer.bin  voice.bin
   ```

   Contoh dari komputer pengembangan: `scp apps/api/storage/tts/supertonic3/* <user>@<server>:/opt/timbangan-registrasi/deploy/storage/tts/`. Asal model dan cara mengunduhnya ada di `apps/api/README.md`. Bila `TTS_ENGINE=supertonic` tetapi ada berkas yang hilang, API berhenti saat mulai dan menyebut nama berkasnya.

6. Build image. Langkah ini memakan waktu beberapa menit:

   ```sh
   docker compose build
   ```

7. Jalankan:

   ```sh
   docker compose up -d
   docker compose ps
   ```

   Tunggu sampai `db`, `api`, dan `web` berstatus `healthy`. Saat mulai, container API menjalankan migrasi database lebih dulu; di log tertulis `Applied N migrations: ...` atau `Nothing to apply: ...`:

   ```sh
   docker compose logs api
   ```

8. Periksa dari komputer lain di jaringan:

   ```sh
   curl http://timbangan.example.com/api/health
   ```

   Jawaban yang benar: `{"status":"ok","database":"up","version":"..."}`.

9. Buat akun admin pertama. Kata sandi acak dicetak sekali di layar; catat lalu ganti setelah masuk:

   ```sh
   docker compose exec api node dist/cli/user-create.js --username admin --full-name "Admin Sistem" --kind INTERNAL --admin
   ```

10. Bila denah ruang kontrol sudah ada, impor sekarang (lihat [Denah ruang kontrol](#denah-ruang-kontrol)).

11. Buka `PUBLIC_URL` di browser dan masuk dengan akun admin.

## Alamat untuk program lain

Semua bagian sistem memakai satu alamat, yaitu nilai `PUBLIC_URL`. Caddy meneruskan `/api/...` ke API dan alamat lain ke web.

- Browser: `PUBLIC_URL`, misalnya `https://timbangan.example.com`.
- Program timbangan dan aplikasi ponsel: alamat server adalah `PUBLIC_URL`. Semua rute API berawalan `/api/`, misalnya `/api/weighbridge/weigh`. Di keduanya alamat diisi tanpa `/api` di akhir (`apps/desktop/src/main/api-client.ts`, `apps/mobile/src/state/session.tsx`).
- Alat GPS atau server penyedia GPS: `POST <PUBLIC_URL>/api/gps/positions` dengan header `X-Tracker-Key`.

Bila `TLS_MODE=internal`, setiap perangkat yang memanggil alamat itu harus memercayai sertifikat akar Caddy (lihat di bawah), termasuk PC timbangan.

## HTTPS

Bawaan `.env.example` adalah HTTP biasa di port 80. Di LAN itu cukup untuk web, program timbangan, dan aplikasi ponsel: cookie sesi web diberi tanda `Secure` hanya bila `PUBLIC_URL` berawalan `https://` (`apps/api/src/auth/sessions.ts`). Lalu lintasnya tidak terenkripsi, jadi pakai hanya di jaringan yang dipercaya.

HTTPS diperlukan untuk dua hal:

- Berbagi lokasi supir dari browser ponsel. Browser hanya memberi lokasi pada halaman `https://` (kecuali `localhost`).
- Alamat yang dibuka dari internet. Halaman berbagi lokasi dibuka dari ponsel supir di jalan, dan server penyedia GPS mengirim posisi dari luar jaringan. Keduanya butuh server yang terjangkau dari internet, jadi pakai pilihan 1.

Ada dua cara memakai HTTPS. Setelah mengubah `PUBLIC_URL`, image web harus di-build ulang karena alamat itu tertanam di kode browser:

```sh
docker compose build web
docker compose up -d
```

### Pilihan 1: nama domain publik

Caddy mengambil sertifikat sendiri dari Let's Encrypt dan memperbaruinya sendiri.

Syarat: nama domain mengarah (DNS A) ke alamat IP publik server, dan port 80 serta 443 server terjangkau dari internet.

```
SITE_ADDRESS=timbangan.example.com
TLS_MODE=auto
PUBLIC_URL=https://timbangan.example.com
```

### Pilihan 2: `tls internal` untuk LAN

Caddy membuat otoritas sertifikat sendiri dan menerbitkan sertifikat untuk nama LAN atau alamat IP server. Tidak perlu internet, tetapi setiap perangkat harus memercayai sertifikat akar Caddy.

```
SITE_ADDRESS=timbangan.example.com
TLS_MODE=internal
PUBLIC_URL=https://timbangan.example.com
```

`SITE_ADDRESS` boleh berupa alamat IP server; `PUBLIC_URL` lalu `https://<alamat IP>`.

Setelah `docker compose up -d`, ambil sertifikat akarnya:

```sh
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt storage/caddy-root.crt
```

Pasang `storage/caddy-root.crt` sebagai sertifikat akar tepercaya di setiap PC, ponsel, dan PC timbangan. Aplikasi Android sejak Android 7 secara bawaan tidak memercayai sertifikat yang dipasang pengguna, dan aplikasi ponsel di `apps/mobile` tidak mengubah bawaan itu. Dengan `tls internal`, aplikasi ponsel karena itu diperkirakan menolak sambungan; ini belum dicoba. Untuk aplikasi ponsel pakai HTTP di LAN atau nama domain publik.

Sertifikat akar dan kuncinya tersimpan di volume `caddy-data`. Bila volume itu hilang, Caddy membuat akar baru dan semua perangkat harus memasangnya lagi. Sertakan volume itu dalam backup.

### Pasangan nilai yang sah

| `SITE_ADDRESS` | `TLS_MODE` | `PUBLIC_URL` |
|---|---|---|
| `:80` | `auto` | `http://<nama atau IP server>` |
| nama domain publik | `auto` | `https://<nama domain>` |
| nama LAN atau IP | `internal` | `https://<nama LAN atau IP>` |

`:80` dengan `internal` ditolak Caddy saat mulai.

## Pekerjaan terjadwal dan alat baris perintah

Yang sudah berjalan sendiri di dalam proses API, tanpa jadwal di host:

- Tarik data Odoo (semua kontrak) lalu VCF, sekali sehari pada jam `SYNC_DAILY_AT` waktu pabrik (`apps/api/src/sync/daily.ts`). Lihat [Jadwal tarik data](#jadwal-tarik-data-odoo-dan-vcf).
- Pemberitahuan: tiap 5 detik API membuat pemberitahuan untuk permintaan keputusan yang baru dan, bila `PUSH_PROVIDER=fcm`, mengirim push yang tertunda (`apps/api/src/notifications/sender.ts`).
- Penghapusan titik GPS yang melewati masa simpan: pertama 5 menit setelah API mulai, lalu sekali sehari (`apps/api/src/gps/retention.ts`). Masa simpannya diatur di aplikasi.
- Pembuatan audio kalimat tetap saat API mulai, bila suara aktif.
- Kedaluwarsa trip dihitung saat data trip dibaca, bukan oleh jadwal.
- Pembaruan layar kontrol hanya berjalan selama ada yang membuka layar itu.

Alat baris perintah dijalankan di container API yang sedang berjalan. Di dalam image tidak ada `npm run`; alat dipanggil langsung dengan `node`, dan argumennya ditulis tanpa `--` di depan.

| Alat | Perintah | Kapan |
|---|---|---|
| Migrasi database | `docker compose exec api node dist/cli/migrate.js` | Otomatis setiap container API mulai; perintah ini hanya bila perlu manual |
| Buat akun | `docker compose exec api node dist/cli/user-create.js --username <u> --full-name "<nama>" --kind INTERNAL [--admin]` | Bila perlu. Untuk akun partner: `--kind PARTNER --partner-id <id>` |
| Sinkron Odoo | `docker compose exec api node dist/cli/sync-odoo.js` (tambahkan `--full` untuk membaca semua kontrak) | Hanya bila perlu di luar jadwal harian |
| Sinkron VCF | `docker compose exec api node dist/cli/sync-vcf.js` | Hanya bila perlu di luar jadwal harian |
| Impor data lama | `docker compose exec api node dist/cli/legacy-import.js [--dry-run] [--since=YYYY-MM-DD] [--only=trips,exceptions,vehicles,seals,cards] [--resume]` | Sekali, saat peralihan. Perlu `LEGACY_DATABASE_URL` |
| Saldo awal kontrak | `docker compose exec api node dist/cli/cutover-opening.js [--dry-run] [--again] [--stale-ok]` | Sekali, pada hari peralihan, setelah impor data lama dan `sync-odoo.js --full` |
| Impor denah | `docker compose exec api node dist/control-room/plan-import.js /plan/<berkas>.json` | Saat denah berubah |

`user-create.js` memakai kata sandi dari variabel `NEW_USER_PASSWORD` bila ada; tanpa itu kata sandi acak dicetak sekali. Untuk memberi kata sandi sendiri tanpa menuliskannya di riwayat shell:

```sh
read -rs NEW_USER_PASSWORD && export NEW_USER_PASSWORD
docker compose exec -e NEW_USER_PASSWORD api node dist/cli/user-create.js --username <u> --full-name "<nama>" --kind INTERNAL
unset NEW_USER_PASSWORD
```

### Jadwal tarik data Odoo dan VCF

API menarik data sendiri sekali sehari pada jam `SYNC_DAILY_AT` (format `HH:MM`, waktu pabrik; di `.env.example` diisi `18:15`). Urutannya Odoo dengan semua kontrak, lalu VCF, masing-masing hanya bila sudah diatur di `.env`. Tidak perlu cron di host. Kosongkan `SYNC_DAILY_AT` untuk mematikan jadwal.

Tombol "Ambil dari Odoo" dan "Ambil dari VCF" di web tetap bisa dipakai kapan saja. Jadwal harian dan tombol memakai penjaga yang sama: tarikan yang sedang berjalan tidak dimulai dua kali. Bila tarikan harian gagal, galatnya tercatat di log API dan di riwayat tarikan; percobaan berikutnya esok hari.

Alat baris perintah `sync-odoo.js` dan `sync-vcf.js` berjalan di proses lain dan tidak terlihat oleh penjaga itu, jadi jangan dijalankan bersamaan dengan jam jadwal.

### Denah ruang kontrol

Denah adalah data perusahaan: tidak masuk git dan tidak masuk image. Taruh berkas JSON denah beserta gambar SVG (dan PNG atau JPEG bila ada) di `deploy/storage/plan/` di server. Path gambar di dalam JSON ditulis relatif terhadap berkas JSON. Folder itu terpasang baca-saja di container API sebagai `/plan`:

```sh
docker compose exec api node dist/control-room/plan-import.js /plan/<berkas>.json
```

Alat itu menyalin gambar ke folder berkas API (`/data/files/control-room/plan-<kode lokasi>.svg`, volume `api-files`) dan menyimpan bentuk zona di database. Berkas di `storage/plan/` boleh dihapus setelah impor, tetapi simpan salinannya di tempat lain.

## Pembaruan

1. Buat backup (bagian berikut).
2. Ambil kode baru dan build ulang:

   ```sh
   cd /opt/timbangan-registrasi
   git pull
   cd deploy
   docker compose build
   docker compose up -d
   ```

3. Periksa `docker compose ps` dan `docker compose logs api`. Migrasi baru dijalankan otomatis saat API mulai. Bila migrasi gagal, container API berhenti dan dimulai ulang terus; pesannya ada di log API.
4. Hapus image lama yang tidak dipakai: `docker image prune -f`.

Pembaruan image PostgreSQL dan Caddy ke rilis terbaru versi yang sama: `docker compose pull db proxy` lalu `docker compose up -d`.

## Backup dan pemulihan

Yang perlu dibackup:

- Database (`pg_dump`).
- Volume `api-files`: foto yang diunggah dan gambar denah.
- Volume `caddy-data`, bila memakai `tls internal`.
- `deploy/.env`, disimpan terpisah dan aman, sebab berisi kata sandi.

Folder `storage/backups/` tidak masuk git. Salin hasil backup ke mesin lain.

### Backup

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > storage/backups/db-$(date +%Y%m%d-%H%M).dump
docker compose exec -T api tar czf - -C /data/files . > storage/backups/files-$(date +%Y%m%d-%H%M).tar.gz
```

Periksa bahwa berkas dump tidak kosong: `ls -l storage/backups/`.

### Pemulihan database

Pemulihan menghapus isi database sekarang.

```sh
docker compose stop proxy web api
docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < storage/backups/db-<tanggal>.dump
docker compose up -d
```

Bila backup berasal dari versi aplikasi yang lebih lama, migrasi yang belum ada dijalankan saat API mulai.

### Pemulihan berkas

```sh
docker compose run --rm --no-deps -T api tar xzf - -C /data/files < storage/backups/files-<tanggal>.tar.gz
```

## Letak data

| Data | Tempat | Keterangan |
|---|---|---|
| Database | volume `timbangan_db-data` | `/var/lib/postgresql/data` di container `db` |
| Berkas unggahan dan denah | volume `timbangan_api-files` | `/data/files` di container `api` (`FILE_STORAGE_DIR`) |
| Cache audio suara | volume `timbangan_api-tts-cache` | `/data/tts-cache` (`TTS_CACHE_DIR`); boleh hilang, dibuat ulang |
| Model suara | folder `deploy/storage/tts/` | `/models/tts`, baca-saja (`TTS_MODEL_DIR`) |
| Bahan impor denah | folder `deploy/storage/plan/` | `/plan`, baca-saja |
| Kunci Firebase | folder `deploy/storage/firebase/` | `/secrets/firebase`, baca-saja; dipakai bila `PUSH_PROVIDER=fcm` |
| Sertifikat Caddy | volume `timbangan_caddy-data` | `/data` di container `proxy` |
| Pengaturan dan rahasia | berkas `deploy/.env` | tidak masuk git |

Lokasi volume di disk host: `docker volume inspect timbangan_db-data`.

`docker compose down` menghentikan container tanpa menghapus volume. Jangan memakai `docker compose down -v` kecuali memang ingin menghapus semua data.

Membuka database dengan `psql`:

```sh
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## Log

```sh
docker compose logs -f api            # API, terus mengikuti
docker compose logs --since 1h web    # web, satu jam terakhir
docker compose logs proxy db
```

Log tiap container dibatasi 5 berkas x 10 MB, lalu yang lama dibuang. Caddy hanya mencatat galat; log akses tidak dinyalakan.

Alamat IP yang tercatat di sesi dan audit adalah alamat pengguna yang diteruskan Caddy: `docker-compose.yml` menyalakan `TRUST_PROXY` di API, dan API hanya memercayai satu proxy di depannya.

## Belum diuji

Berkas di folder ini ditulis di komputer tanpa Docker. Belum ada yang dijalankan:

- `docker compose build` untuk kedua image, termasuk `npm ci` dan build di Linux.
- Modul native di Linux: `@node-rs/argon2` (login) dan `sherpa-onnx-node` (suara, dengan `LD_LIBRARY_PATH` di image API).
- `next start` dengan dependensi produksi saja dan `next.config.ts`.
- Migrasi otomatis saat container API mulai, dan semua alat baris perintah lewat `node dist/...`.
- Healthcheck ketiga container.
- `Caddyfile`: snippet kosong `tls-auto`, `tls internal`, sertifikat domain publik, dan server-sent events layar kontrol lewat Caddy.
- Izin tulis user `node` pada volume `api-files` dan `api-tts-cache`.
- Backup dan pemulihan dengan perintah di atas.
- Program timbangan, aplikasi ponsel, dan alat GPS yang memanggil alamat lewat Caddy, dengan HTTP maupun HTTPS.
- Tarik data harian pada jam `SYNC_DAILY_AT` di server yang berjalan, dan push Firebase dari dalam container (akses keluar ke Google, berkas kunci terpasang baca-saja).
