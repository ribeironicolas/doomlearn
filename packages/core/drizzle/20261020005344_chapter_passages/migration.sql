ALTER TABLE `chapters` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `chapters` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `concepts` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `concepts` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `passages` ADD `chapter_id` integer REFERENCES chapters(id);