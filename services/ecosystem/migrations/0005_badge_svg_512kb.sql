-- Raise the byte cap without changing artwork hashes or historical references.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER admin_validate_image;
DROP TRIGGER admin_apply;
CREATE TABLE badge_art_expanded (
 id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^a-f0-9]*'),
 svg TEXT NOT NULL CHECK(length(CAST(svg AS BLOB)) BETWEEN 1 AND 524288),
 created_at INTEGER NOT NULL
);
INSERT INTO badge_art_expanded SELECT id,svg,created_at FROM badge_art;
DROP TABLE badge_art;
ALTER TABLE badge_art_expanded RENAME TO badge_art;
CREATE TRIGGER badge_art_no_update BEFORE UPDATE ON badge_art BEGIN SELECT RAISE(ABORT,'admin_art_immutable'); END;
CREATE TRIGGER badge_art_no_delete BEFORE DELETE ON badge_art BEGIN SELECT RAISE(ABORT,'admin_art_immutable'); END;
CREATE TRIGGER admin_validate_image BEFORE INSERT ON admin_audit
WHEN NEW.action IN('badge.create','badge.update') AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key)
BEGIN
 SELECT CASE WHEN json_type(NEW.after_json,'$.image') IS NOT NULL AND json_type(NEW.after_json,'$.image') NOT IN('null','text') THEN RAISE(ABORT,'admin_invalid_badge') END;
 SELECT CASE WHEN json_type(NEW.after_json,'$.image')='text' AND (
  length(json_extract(NEW.after_json,'$.image'))<>64 OR json_extract(NEW.after_json,'$.image') GLOB '*[^a-f0-9]*' OR
  (NOT EXISTS(SELECT 1 FROM badge_art WHERE id=json_extract(NEW.after_json,'$.image')) AND json_type(NEW.after_json,'$.svg') IS NOT 'text')
 ) THEN RAISE(ABORT,'admin_invalid_badge') END;
 SELECT CASE WHEN json_type(NEW.after_json,'$.svg') IS NOT NULL AND (
  json_type(NEW.after_json,'$.svg') IS NOT 'text' OR json_type(NEW.after_json,'$.image') IS NOT 'text' OR
  length(CAST(json_extract(NEW.after_json,'$.svg') AS BLOB)) NOT BETWEEN 1 AND 524288 OR
  EXISTS(SELECT 1 FROM badge_art WHERE id=json_extract(NEW.after_json,'$.image') AND svg<>json_extract(NEW.after_json,'$.svg'))
 ) THEN RAISE(ABORT,'admin_invalid_badge') END;
END;
CREATE TRIGGER admin_apply AFTER INSERT ON admin_audit BEGIN
 INSERT INTO badge_art(id,svg,created_at)
 SELECT json_extract(NEW.after_json,'$.image'),json_extract(NEW.after_json,'$.svg'),NEW.created_at
 WHERE NEW.action IN('badge.create','badge.update') AND json_type(NEW.after_json,'$.svg')='text'
 ON CONFLICT(id) DO NOTHING;
 INSERT INTO badges(id,name,description,art,price,available,revision,image)
 SELECT NEW.target_id,json_extract(NEW.after_json,'$.name'),json_extract(NEW.after_json,'$.description'),json_extract(NEW.after_json,'$.art'),json_extract(NEW.after_json,'$.price'),json_extract(NEW.after_json,'$.available'),1,json_extract(NEW.after_json,'$.image')
 WHERE NEW.action='badge.create';
 UPDATE badges SET name=json_extract(NEW.after_json,'$.name'),description=json_extract(NEW.after_json,'$.description'),art=json_extract(NEW.after_json,'$.art'),price=json_extract(NEW.after_json,'$.price'),available=json_extract(NEW.after_json,'$.available'),revision=revision+1,image=json_extract(NEW.after_json,'$.image')
 WHERE id=NEW.target_id AND NEW.action='badge.update';
 UPDATE badges SET is_deleted=1,available=0,revision=revision+1 WHERE id=NEW.target_id AND NEW.action='badge.delete';
END;
PRAGMA defer_foreign_keys=OFF;
