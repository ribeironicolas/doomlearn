CREATE TABLE `usage_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider` text NOT NULL,
	`window` text NOT NULL,
	`utilization` real,
	`resets_at` integer,
	`status` text,
	`source` text NOT NULL,
	`call_id` integer,
	`captured_at` integer NOT NULL,
	CONSTRAINT `fk_usage_snapshots_call_id_agent_calls_id_fk` FOREIGN KEY (`call_id`) REFERENCES `agent_calls`(`id`)
);
