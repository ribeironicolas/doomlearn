-- Accent-insensitive caption search over Clips, kept in sync by triggers.
CREATE VIRTUAL TABLE `clips_fts` USING fts5(`caption`, content='clips', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
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
