CREATE TABLE `worker_status` (
	`id` integer PRIMARY KEY,
	`liveness` text DEFAULT 'stopped' NOT NULL,
	`server_pid` integer,
	`exit_reason` text,
	`restarts` integer DEFAULT 0 NOT NULL,
	`job_id` integer,
	`stage` text,
	`stage_started_at` integer,
	`blockers` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `fk_worker_status_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`)
);
