ALTER TABLE badges ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 2147483647);
CREATE INDEX purchases_badge ON purchases(badge_id);
CREATE TABLE admin_challenges (
 state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN(0,1)), expires_at INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
 hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, username TEXT NOT NULL, csrf TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE admin_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, request_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('badge.create','badge.update','badge.delete','session.login','session.logout')),
 target_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 request_hash TEXT NOT NULL, before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
 after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)), created_at INTEGER NOT NULL,
 UNIQUE(actor_id,request_key)
);
-- Audit insertion is the command: the mutation and its immutable record commit
-- together. Failed revision/ownership/constraint checks roll the entire row back.
CREATE TRIGGER admin_validate BEFORE INSERT ON admin_audit
WHEN NOT EXISTS(SELECT 1 FROM admin_audit WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key)
BEGIN
 SELECT CASE WHEN NEW.action='badge.create' AND (NEW.expected_revision<>0 OR EXISTS(SELECT 1 FROM badges WHERE id=NEW.target_id)) THEN RAISE(ABORT,'admin_badge_exists') END;
 SELECT CASE WHEN NEW.action='badge.create' AND (SELECT COUNT(*) FROM badges)>=512 THEN RAISE(ABORT,'admin_catalog_full') END;
 SELECT CASE WHEN NEW.action IN('badge.update','badge.delete') AND NOT EXISTS(SELECT 1 FROM badges WHERE id=NEW.target_id AND revision=NEW.expected_revision) THEN RAISE(ABORT,'admin_revision_conflict') END;
 SELECT CASE WHEN NEW.action='badge.delete' AND EXISTS(SELECT 1 FROM purchases WHERE badge_id=NEW.target_id) THEN RAISE(ABORT,'admin_badge_in_use') END;
 SELECT CASE WHEN NEW.action IN('badge.create','badge.update') AND (
  NEW.after_json IS NULL OR json_extract(NEW.after_json,'$.id') IS NOT NEW.target_id OR
  json_type(NEW.after_json,'$.name') IS NOT 'text' OR length(json_extract(NEW.after_json,'$.name')) NOT BETWEEN 1 AND 80 OR
  json_type(NEW.after_json,'$.description') IS NOT 'text' OR length(json_extract(NEW.after_json,'$.description'))>500 OR
  json_type(NEW.after_json,'$.price') IS NOT 'integer' OR json_extract(NEW.after_json,'$.price') NOT BETWEEN 1 AND 1000000 OR
  json_extract(NEW.after_json,'$.art') NOT IN('spark','orbit','shield','compass') OR json_type(NEW.after_json,'$.art') IS NOT 'text' OR
  json_type(NEW.after_json,'$.available') IS NOT 'integer' OR json_extract(NEW.after_json,'$.available') NOT IN(0,1) OR
  json_extract(NEW.after_json,'$.revision') IS NOT NEW.expected_revision+1
 ) THEN RAISE(ABORT,'admin_invalid_badge') END;
END;
CREATE TRIGGER admin_apply AFTER INSERT ON admin_audit BEGIN
 INSERT INTO badges(id,name,description,art,price,available,revision)
 SELECT NEW.target_id,json_extract(NEW.after_json,'$.name'),json_extract(NEW.after_json,'$.description'),json_extract(NEW.after_json,'$.art'),json_extract(NEW.after_json,'$.price'),json_extract(NEW.after_json,'$.available'),1
 WHERE NEW.action='badge.create';
 UPDATE badges SET name=json_extract(NEW.after_json,'$.name'),description=json_extract(NEW.after_json,'$.description'),art=json_extract(NEW.after_json,'$.art'),price=json_extract(NEW.after_json,'$.price'),available=json_extract(NEW.after_json,'$.available'),revision=revision+1
 WHERE id=NEW.target_id AND NEW.action='badge.update';
 DELETE FROM badges WHERE id=NEW.target_id AND NEW.action='badge.delete';
END;
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'admin_audit_immutable'); END;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'admin_audit_immutable'); END;
