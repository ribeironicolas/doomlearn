ALTER TABLE `claude_calls` ADD `retry_at` integer;--> statement-breakpoint
ALTER TABLE `concepts` ADD `from_split` integer DEFAULT false NOT NULL;