ALTER TABLE "session_roster" ADD COLUMN "games_played" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_roster" ADD COLUMN "wins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_roster" ADD COLUMN "losses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_roster" ADD COLUMN "bench_entered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_roster" ADD COLUMN "last_game_finished_at" timestamp with time zone;