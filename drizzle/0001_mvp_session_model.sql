CREATE TABLE "club_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"started_by_admin_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "match_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"active_court_index" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now(),
	"winner_side" text NOT NULL,
	"winner_score" integer NOT NULL,
	"loser_score" integer NOT NULL,
	"slot_1_profile_id" uuid,
	"slot_2_profile_id" uuid,
	"slot_3_profile_id" uuid,
	"slot_4_profile_id" uuid
);
--> statement-breakpoint
CREATE TABLE "session_placements" (
	"session_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"court_index" integer,
	"slot_number" integer,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "session_placements_bench_shape" CHECK (("session_placements"."kind") <> 'bench' OR ("session_placements"."court_index" IS NULL AND "session_placements"."slot_number" IS NULL)),
	CONSTRAINT "session_placements_court_shape" CHECK (("session_placements"."kind") = 'bench' OR ("session_placements"."court_index" IS NOT NULL AND "session_placements"."slot_number" IS NOT NULL AND "session_placements"."slot_number" BETWEEN 1 AND 4))
);
--> statement-breakpoint
CREATE TABLE "session_roster" (
	"session_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "session_roster_session_id_profile_id_pk" PRIMARY KEY("session_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "session_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_session_id" uuid,
	"organization_id" uuid NOT NULL,
	"snapshot_name" text NOT NULL,
	"snapshot_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "snapshot_player_stats" (
	"snapshot_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"matches_played" integer NOT NULL,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	CONSTRAINT "snapshot_player_stats_snapshot_id_profile_id_pk" PRIMARY KEY("snapshot_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "mmr" SET DEFAULT 500;--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "mmr" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "club_sessions" ADD CONSTRAINT "club_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sessions" ADD CONSTRAINT "club_sessions_started_by_admin_id_profiles_id_fk" FOREIGN KEY ("started_by_admin_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_session_id_club_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."club_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_slot_1_profile_id_profiles_id_fk" FOREIGN KEY ("slot_1_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_slot_2_profile_id_profiles_id_fk" FOREIGN KEY ("slot_2_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_slot_3_profile_id_profiles_id_fk" FOREIGN KEY ("slot_3_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_slot_4_profile_id_profiles_id_fk" FOREIGN KEY ("slot_4_profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_session_id_club_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."club_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_roster" ADD CONSTRAINT "session_roster_session_id_club_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."club_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_roster" ADD CONSTRAINT "session_roster_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_club_session_id_club_sessions_id_fk" FOREIGN KEY ("club_session_id") REFERENCES "public"."club_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_player_stats" ADD CONSTRAINT "snapshot_player_stats_snapshot_id_session_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."session_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_player_stats" ADD CONSTRAINT "snapshot_player_stats_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_sessions_org_status_idx" ON "club_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "match_results_session_id_idx" ON "match_results" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_placements_session_profile_unique" ON "session_placements" USING btree ("session_id","profile_id");--> statement-breakpoint
CREATE INDEX "session_placements_session_kind_idx" ON "session_placements" USING btree ("session_id","kind");--> statement-breakpoint
CREATE INDEX "session_roster_session_id_idx" ON "session_roster" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "profiles_organization_id_role_idx" ON "profiles" USING btree ("organization_id","role");