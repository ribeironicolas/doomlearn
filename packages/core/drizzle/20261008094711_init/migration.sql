CREATE TABLE `chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	CONSTRAINT `fk_chapters_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`)
);
--> statement-breakpoint
CREATE TABLE `claude_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`stage` text NOT NULL,
	`job_id` integer,
	`source_id` integer,
	`cost_usd` real,
	`tokens_in` integer,
	`tokens_out` integer,
	`duration_ms` integer NOT NULL,
	`is_error` integer NOT NULL,
	`api_error_status` integer,
	`at` integer NOT NULL,
	CONSTRAINT `fk_claude_calls_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`),
	CONSTRAINT `fk_claude_calls_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`)
);
--> statement-breakpoint
CREATE TABLE `clips` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`concept_id` integer NOT NULL,
	`angle` text NOT NULL,
	`script` text NOT NULL,
	`caption` text NOT NULL,
	`file` text NOT NULL,
	`last_seen_at` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_clips_concept_id_concepts_id_fk` FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`),
	CONSTRAINT `clips_concept_id_angle_unique` UNIQUE(`concept_id`,`angle`)
);
--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`ladder_step` integer,
	`due_at` integer,
	`retired_reason` text,
	`not_landing_at` integer,
	`fit_angles` text NOT NULL,
	`source_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_concepts_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`clip_id` integer NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`reason` text,
	`note` text,
	`client_event_id` text UNIQUE,
	CONSTRAINT `fk_events_clip_id_clips_id_fk` FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`kind` text NOT NULL,
	`priority` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`stage` text,
	`chapter_id` integer,
	`concept_id` integer,
	`angle` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_jobs_chapter_id_chapters_id_fk` FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`),
	CONSTRAINT `fk_jobs_concept_id_concepts_id_fk` FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `passages` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`concept_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`anchor` text NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `fk_passages_concept_id_concepts_id_fk` FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`),
	CONSTRAINT `fk_passages_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sha256` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
