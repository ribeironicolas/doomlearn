ALTER TABLE `claude_calls` RENAME TO `agent_calls`;--> statement-breakpoint
ALTER TABLE `agent_calls` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `agent_calls` ADD `model` text;--> statement-breakpoint
ALTER TABLE `agent_calls` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `agent_calls` ADD `error` text;--> statement-breakpoint
-- Hand-added: every v1 call ran on Claude.
UPDATE `agent_calls` SET `provider` = 'claude';
