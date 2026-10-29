-- Hand-ordered. drizzle runs every pending migration in one transaction, where `PRAGMA foreign_keys=OFF` is a no-op,
-- and its `__new_clips` + RENAME rebuild fails at COMMIT, since events and jobs reference clips. PRAGMA
-- defer_foreign_keys moves the foreign key check to COMMIT, when clips holds every id again.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__old_clips` AS SELECT * FROM `clips`;--> statement-breakpoint
DROP TABLE `clips`;--> statement-breakpoint
CREATE TABLE `clips` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`concept_id` integer NOT NULL,
	`angle` text NOT NULL,
	`language` text DEFAULT 'pt-BR' NOT NULL,
	`script` text NOT NULL,
	`caption` text NOT NULL,
	`file` text NOT NULL,
	`last_seen_at` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_clips_concept_id_concepts_id_fk` FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`),
	CONSTRAINT `clips_concept_id_angle_language_unique` UNIQUE(`concept_id`,`angle`,`language`)
);
--> statement-breakpoint
-- Every Clip made so far is pt-BR. Ids are kept, so events and the phone's cached Clips still point at them.
INSERT INTO `clips`(`id`, `concept_id`, `angle`, `script`, `caption`, `file`, `last_seen_at`, `hidden`, `created_at`) SELECT `id`, `concept_id`, `angle`, `script`, `caption`, `file`, `last_seen_at`, `hidden`, `created_at` FROM `__old_clips`;--> statement-breakpoint
DROP TABLE `__old_clips`;--> statement-breakpoint
-- The caption search triggers went with the old table.
CREATE TRIGGER `clips_fts_insert` AFTER INSERT ON `clips` BEGIN
  INSERT INTO `clips_fts`(rowid, `caption`) VALUES (new.`id`, new.`caption`);
END;
--> statement-breakpoint
CREATE TRIGGER `clips_fts_delete` AFTER DELETE ON `clips` BEGIN
  INSERT INTO `clips_fts`(`clips_fts`, rowid, `caption`) VALUES ('delete', old.`id`, old.`caption`);
END;
--> statement-breakpoint
CREATE TRIGGER `clips_fts_update` AFTER UPDATE OF `caption` ON `clips` BEGIN
  INSERT INTO `clips_fts`(`clips_fts`, rowid, `caption`) VALUES ('delete', old.`id`, old.`caption`);
  INSERT INTO `clips_fts`(rowid, `caption`) VALUES (new.`id`, new.`caption`);
END;
--> statement-breakpoint
INSERT INTO `clips_fts`(`clips_fts`) VALUES ('rebuild');--> statement-breakpoint
ALTER TABLE `jobs` ADD `language` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `from_clip_id` integer REFERENCES clips(id);--> statement-breakpoint
-- Every job so far made pt-BR Clips. A queued new or new_angle job keeps NULL: its Clip takes the clips.language
-- default. An extraction job makes no Clip.
UPDATE `jobs` SET `language` = 'pt-BR' WHERE `kind` != 'extract_chapter' AND NOT (`status` = 'queued' AND `kind` IN ('new', 'new_angle'));--> statement-breakpoint
CREATE TABLE `favorites` (
	`clip_id` integer PRIMARY KEY,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_favorites_clip_id_clips_id_fk` FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`)
);
--> statement-breakpoint
CREATE TABLE `previews` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`clip_id` integer NOT NULL,
	`language` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`wav_path` text,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_previews_clip_id_clips_id_fk` FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`)
);
