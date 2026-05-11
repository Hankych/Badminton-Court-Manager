# Origin Badminton Court Manager

Next.js app for managing live badminton sessions with admin/player views, persisted court state, match recording, MMR updates, and session history.

## Features

- Admin login and player login
- Live session creation with an empty roster
- Manage Players tab for creating/editing/deleting player accounts
- Add/remove players from the current session while it is live
- Active courts, queue courts, and bench tracking
- Drag/drop players between bench, queue, and active courts
- Bench player multi-select with active/queue court placement
- Bench match suggestion based on wait time and MMR spread
- Match result recording with badminton score validation
- Team-average Elo-style MMR updates
- Queue promotion after a match is recorded
- Session snapshots and player history
- Polling-based live refresh so admin/player accounts see current board state

## Tech Stack

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Neon Postgres
- Drizzle ORM
- Cookie-based login

## Local Development

```bash
npm install
npm run dev
```

App: [http://localhost:3000](http://localhost:3000)

## Environment

Create `.env.local`:

```env
DATABASE_URL=...
SESSION_SECRET=...
SEED_ADMIN_PASSWORD=...
SEED_BULK_PLAYERS_PASSWORD=...
```

Notes:

- `DATABASE_URL` is required for the app, Drizzle, and seed scripts.
- `SESSION_SECRET` must be at least 16 characters.
- `SEED_BULK_PLAYERS_PASSWORD` is used by `npm run seed:players24`.
- `SEED_PLAYER_PASSWORD` can be used as a fallback for bulk player seeding.

## Database

Schema source of truth:

- `src/db/schema.ts`

Drizzle migrations:

- `drizzle/`

Useful commands:

```bash
npm run db:generate
npm run db:push
npm run db:studio
```

Health check:

```text
GET /api/health/db
```

## Seeding

Seed the organization/admin:

```bash
npx tsx scripts/seed.ts
```

Seed 24 demo players:

```bash
npm run seed:players24
```

Equivalent direct command:

```bash
npx tsx scripts/seed-24-players.ts
```

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run db:generate
npm run db:push
npm run db:studio
npm run seed:players24
```
