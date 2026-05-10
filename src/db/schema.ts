/**
 * Neon Postgres schema (Drizzle) — single-organization MVP.
 *
 * Flow: admin creates org users (profiles). Admin starts a `club_session`,
 * assigns `session_roster` (players in this session). While live, UI state
 * maps to `session_placements`. Recording a match inserts `match_results`.
 * Finish session inserts `session_snapshots` + `snapshot_player_stats` for history.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  date,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** One row per venue / club tenant (single org for MVP). */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/** Login identity: exactly one admin and many players per org in MVP. */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "admin" | "player" — enforce in application (or migrate to pg enum later). */
    role: text("role").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    mmr: integer("mmr").notNull().default(500),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    orgUsernameUnique: uniqueIndex("profiles_org_username_unique").on(t.organizationId, t.username),
    orgRoleIdx: index("profiles_organization_id_role_idx").on(t.organizationId, t.role),
  }),
);

/** A single run of desk time (started by admin). */
export const clubSessions = pgTable(
  "club_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    startedByAdminId: uuid("started_by_admin_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    /** draft = picking roster | active | ended */
    status: text("status").notNull().default("draft"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    orgStatusIdx: index("club_sessions_org_status_idx").on(t.organizationId, t.status),
  }),
);

/** Players included in this session (multi-select at “Start session”). */
export const sessionRoster = pgTable(
  "session_roster",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => clubSessions.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow(),
    gamesPlayed: integer("games_played").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    /** Used for “time off court” on bench (set when player is placed on bench). */
    benchEnteredAt: timestamp("bench_entered_at", { withTimezone: true }),
    lastGameFinishedAt: timestamp("last_game_finished_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.profileId] }),
    sessionIdx: index("session_roster_session_id_idx").on(t.sessionId),
  }),
);

/**
 * Current board location for each rostered player in an active session.
 * bench: courtIndex + slotNumber null
 * active | queue: courtIndex 1..N, slotNumber 1..4
 */
export const sessionPlacements = pgTable(
  "session_placements",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => clubSessions.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    /** bench | active | queue */
    kind: text("kind").notNull(),
    courtIndex: integer("court_index"),
    slotNumber: integer("slot_number"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    sessionProfileUnique: uniqueIndex("session_placements_session_profile_unique").on(t.sessionId, t.profileId),
    sessionKindIdx: index("session_placements_session_kind_idx").on(t.sessionId, t.kind),
    benchOnly: check(
      "session_placements_bench_shape",
      sql`(${t.kind}) <> 'bench' OR (${t.courtIndex} IS NULL AND ${t.slotNumber} IS NULL)`,
    ),
    courtShape: check(
      "session_placements_court_shape",
      sql`(${t.kind}) = 'bench' OR (${t.courtIndex} IS NOT NULL AND ${t.slotNumber} IS NOT NULL AND ${t.slotNumber} BETWEEN 1 AND 4)`,
    ),
  }),
);

/** One row per recorded match on an active court. */
export const matchResults = pgTable(
  "match_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => clubSessions.id, { onDelete: "cascade" }),
    /** Which active court (1-based). */
    activeCourtIndex: integer("active_court_index").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow(),
    winnerSide: text("winner_side").notNull(),
    winnerScore: integer("winner_score").notNull(),
    loserScore: integer("loser_score").notNull(),
    slot1ProfileId: uuid("slot_1_profile_id").references(() => profiles.id),
    slot2ProfileId: uuid("slot_2_profile_id").references(() => profiles.id),
    slot3ProfileId: uuid("slot_3_profile_id").references(() => profiles.id),
    slot4ProfileId: uuid("slot_4_profile_id").references(() => profiles.id),
  },
  (t) => ({
    sessionIdx: index("match_results_session_id_idx").on(t.sessionId),
  }),
);

/** Immutable snapshot when a session is finished (admin “Finish session”). */
export const sessionSnapshots = pgTable("session_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  clubSessionId: uuid("club_session_id").references(() => clubSessions.id, { onDelete: "set null" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  snapshotName: text("snapshot_name").notNull(),
  snapshotDate: date("snapshot_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/** Per-player stats inside one snapshot (for player history list). */
export const snapshotPlayerStats = pgTable(
  "snapshot_player_stats",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => sessionSnapshots.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    matchesPlayed: integer("matches_played").notNull(),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.profileId] }),
  }),
);
