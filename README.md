# Origin Badminton Session Manager

Next.js MVP for live badminton session operations:

- Active / ghost courts and bench queue
- Result recording with strict badminton score validation
- Elo-style MMR updates (K=24), admin-editable MMR
- Bench match suggestion (wait time + MMR spread)
- Finish session with snapshot vs abandon

## Local development

```bash
npm install
npm run dev
```

App: [http://localhost:3000](http://localhost:3000).

Create **`.env.local`** (not committed) with at least:

- **`DATABASE_URL`** — Neon pooled Postgres URL
- **`SESSION_SECRET`** — long random string (cookies / JWT)
- **`SEED_ADMIN_PASSWORD`** — for `npx tsx scripts/seed.ts`
- **`SEED_BULK_PLAYERS_PASSWORD`** or **`SEED_PLAYER_PASSWORD`** — for `npm run seed:players24` (see script headers)

Neon smoke check (no auth): `GET /api/health/db`.

## Database (Neon + Drizzle)

`DATABASE_URL` must be set for the app, Drizzle Kit (`db:push`), and seed scripts.

**Where the schema lives**

- **`src/db/schema.ts`** — source of truth: all tables/columns the app and Drizzle ORM use.

**What the `drizzle/` folder is**

- SQL migration files + `meta/` journal produced by **Drizzle Kit** (`npm run db:generate`).
- Use them if you apply versioned migrations; or use **`npm run db:push`** to sync `schema.ts` straight to the DB (no hand-written SQL).

Scripts:

- `npm run db:generate` — generate a new migration from `schema.ts` changes
- `npm run db:push` — push schema to Neon (dev-friendly)
- `npm run db:studio` — Drizzle Studio

**Seeding**

```bash
# Org + admin (+ optional demo players). Requires SEED_ADMIN_PASSWORD, DATABASE_URL.
npx tsx scripts/seed.ts

# 24 player accounts. Requires SEED_BULK_PLAYERS_PASSWORD (or SEED_PLAYER_PASSWORD), DATABASE_URL.
npm run seed:players24
```

Also set `SESSION_SECRET` (and related auth env) as needed for login in your environment.
