-- Preserve catalog identities, purchases, ownership and immutable history.
ALTER TABLE badges ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0 CHECK(is_deleted IN(0,1) AND (is_deleted=0 OR available=0));
CREATE TRIGGER badges_no_hard_delete BEFORE DELETE ON badges BEGIN SELECT RAISE(ABORT,'admin_soft_delete_required'); END;
CREATE TRIGGER badges_deleted_readonly BEFORE UPDATE ON badges WHEN OLD.is_deleted=1 BEGIN SELECT RAISE(ABORT,'admin_badge_deleted'); END;
CREATE TRIGGER badges_soft_delete_deactivate AFTER UPDATE OF is_deleted ON badges WHEN OLD.is_deleted=0 AND NEW.is_deleted=1 BEGIN
 UPDATE owned_badges SET active=0 WHERE badge_id=NEW.id;
END;
-- This guard runs inside the activation batch, closing delete/activate races.
CREATE TRIGGER active_badge_not_deleted BEFORE UPDATE OF active ON owned_badges WHEN NEW.active=1 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM badges WHERE id=NEW.badge_id AND is_deleted=1) THEN RAISE(ABORT,'badge_unavailable') END;
END;
DROP TRIGGER admin_validate;
CREATE TRIGGER admin_validate BEFORE INSERT ON admin_audit
WHEN NOT EXISTS(SELECT 1 FROM admin_audit WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key)
BEGIN
 SELECT CASE WHEN NEW.action='badge.create' AND (NEW.expected_revision<>0 OR EXISTS(SELECT 1 FROM badges WHERE id=NEW.target_id)) THEN RAISE(ABORT,'admin_badge_exists') END;
 SELECT CASE WHEN NEW.action='badge.create' AND (SELECT COUNT(*) FROM badges WHERE is_deleted=0)>=512 THEN RAISE(ABORT,'admin_catalog_full') END;
 SELECT CASE WHEN NEW.action IN('badge.update','badge.delete') AND NOT EXISTS(SELECT 1 FROM badges WHERE id=NEW.target_id AND revision=NEW.expected_revision AND is_deleted=0) THEN RAISE(ABORT,'admin_revision_conflict') END;
 SELECT CASE WHEN NEW.action='badge.delete' AND (
  NEW.after_json IS NULL OR json_extract(NEW.after_json,'$.id') IS NOT NEW.target_id OR
  json_extract(NEW.after_json,'$.is_deleted') IS NOT 1 OR json_extract(NEW.after_json,'$.available') IS NOT 0 OR
  json_extract(NEW.after_json,'$.revision') IS NOT NEW.expected_revision+1
 ) THEN RAISE(ABORT,'admin_invalid_badge') END;
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
DROP TRIGGER admin_apply;
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
