# KapadKart API

Express 5 API for KapadKart. It uses plain JavaScript (ES modules), PostgreSQL, and Prisma. There is no compile step: `npm run dev` runs `node --watch`.

The shop app (`kapadkart-fe`) and the admin panel (`kapadkart-admin`) are separate projects. This service is the only one that talks to the database.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- PostgreSQL 15 or newer

The schema creates the `uuid-ossp` extension and an `app` schema. The database user needs permission to do both.

## Setup

```bash
cp .env.example .env
npm install
npx prisma generate
```

### Local PostgreSQL

```bash
psql -U postgres -c "CREATE DATABASE kapadkart;"
```

Set `kapadkart/.env` to use that database:

```env
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
LOCAL_DB_HOST=localhost
LOCAL_DB_PORT=5432
LOCAL_DB_USER=postgres
LOCAL_DB_PASSWORD=postgres
LOCAL_DB_NAME=kapadkart
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kapadkart?schema=app
FRONTEND_ORIGIN=http://localhost:5173,http://localhost:5174
JWT_SECRET=change-me-to-a-long-random-string
STORAGE_PROVIDER=local
LOCAL_UPLOAD_DIR=./uploads
BASE_URL=http://localhost:4000
```

`DATABASE_URL` is what the Prisma CLI reads. At runtime the API builds its connection from `LOCAL_DB_*`. Keep both pointed at the same database.

Generate a production JWT secret with:

```bash
openssl rand -hex 32
```

Environment files are read in this order: `.env.local`, `.env`, `../.env.local`, `../.env`. The first value for a key wins, so a workspace-root `.env.local` does not override a value already set in this directory.

## Create the schema and admin user

```bash
npm run db:setup
npm run dev
```

The API listens on http://localhost:4000.

`db:setup` applies `src/database/schema.sql` and inserts one platform admin:

| Field | Value |
|---|---|
| Email | `admin@kapadkart.com` |
| Username | `kapadkart` |
| Password | `Admin123` |

Sign in to the admin panel with the email and password. Replace this password before anyone else can reach the database.

Check the database from the running server:

```bash
curl http://localhost:4000/api/v1/health
curl http://localhost:4000/api/v1/health/db
```

`/api/v1/health` returns `ok` when Postgres answers, and `degraded` when it does not. The process still stays up.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with `node --watch` on port 4000 |
| `npm start` | Start without file watching |
| `npm test` | Node.js test runner (`tests/**/*.test.js`) |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Apply `src/database/schema.sql` in a transaction |
| `npm run db:seed` | Insert or update the platform admin |
| `npm run db:setup` | Migrate, then seed |
| `npm run db:reset` | Drop schema `app`, recreate it, and seed the admin |
| `npm run db:clean` | Empty every `app` table except `platform_admins` |
| `npm run r2:create` | Create the `kapadkart-images` R2 bucket |
| `npm run r2:cors` | Allow browsers to read images from that bucket |
| `npm run test:smtp` | Check the SMTP settings in `.env` |
| `npx prisma generate` | Regenerate the Prisma client after schema edits |

`db:reset` and `db:clean` delete shop data. Run them only against a database you can afford to wipe.

This repo does not use `prisma migrate`. Edit `prisma/schema.prisma` and `src/database/schema.sql` together, then run `npx prisma generate` and `npm run db:migrate`.

## What the API expects

| Area | Variables |
|---|---|
| Server | `NODE_ENV`, `PORT` (default 4000), `LOG_LEVEL` |
| CORS | `FRONTEND_ORIGIN`, comma-separated, no trailing slash. Local dev needs `http://localhost:5173` and `http://localhost:5174` |
| Auth | `JWT_SECRET` (at least 16 characters), `JWT_EXPIRES_IN` (default `24h`), `JWT_ADMIN_EXPIRES_IN` (default `8h`) |
| Cookies | `COOKIE_DOMAIN`, `COOKIE_SAME_SITE` (`lax`, `strict`, or `none`). Leave unset on localhost |
| Database | `LOCAL_DB_HOST`, `LOCAL_DB_PORT`, `LOCAL_DB_USER`, `LOCAL_DB_PASSWORD`, `LOCAL_DB_NAME`, and `DATABASE_URL` for the Prisma CLI |
| Files | `STORAGE_PROVIDER` is `local`, `s3`, or `r2`. Cloudflare image bytes use `r2` and bucket `kapadkart-images`. The database stores the public URL |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Required for password-reset mail. Empty SMTP settings do not block startup |

Image size limits (`IMAGE_*`) are optional. Defaults live in `src/config/imageConfig.js`.

## HTTP surface

All routes are mounted at `/api/v1`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Service descriptor |
| `GET` | `/api/v1` | Route index |
| `GET` | `/api/v1/health` | Process and database status |
| `GET` | `/api/v1/health/db` | Database probe, including source, host, and database name |
| `POST` | `/api/v1/auth/login` | Shop user or platform admin login |
| `*` | `/api/v1/admin`, `/api/v1/platform`, `/api/v1/tenants` | Platform admin |
| `*` | `/api/v1/tenant` | Shop data (products, bookings, sales, settings) |

Uploaded images are served from `/uploads` when `STORAGE_PROVIDER=local`.

## Layout

```
src/
  config/       env, pg pool, Prisma client
  database/     schema.sql, migrate, seed, reset
  middleware/
  routes/       HTTP routes mounted by src/routes/index.js
  services/     email, storage, PDF
  app.js
  server.js
prisma/schema.prisma
tests/
```
