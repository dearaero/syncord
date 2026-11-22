-- PNG bytes remain private normalized R2 assets; SVG references and history are preserved.
CREATE TABLE admin_badge_png(hash TEXT PRIMARY KEY REFERENCES custom_badge_assets(hash),actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER admin_png_no_update BEFORE UPDATE ON admin_badge_png BEGIN SELECT RAISE(ABORT,'admin_art_immutable'); END;
CREATE TRIGGER admin_png_no_delete BEFORE DELETE ON admin_badge_png BEGIN SELECT RAISE(ABORT,'admin_art_immutable'); END;
ALTER TABLE badges ADD COLUMN png_image TEXT REFERENCES admin_badge_png(hash) CHECK(png_image IS NULL OR image IS NULL);
DROP TRIGGER admin_validate_image;
DROP TRIGGER admin_apply;
CREATE TRIGGER admin_validate_image BEFORE INSERT ON admin_audit
WHEN NEW.action IN('badge.create','badge.update') AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key)
BEGIN
 SELECT CASE WHEN json_type(NEW.after_json,'$.image') IS NOT NULL AND json_type(NEW.after_json,'$.image') NOT IN('null','text') THEN RAISE(ABORT,'admin_invalid_badge') END;
 SELECT CASE WHEN json_type(NEW.after_json,'$.image')='text' AND (
  length(json_extract(NEW.after_json,'$.image'))<>64 OR json_extract(NEW.after_json,'$.image') GLOB '*[^a-f0-9]*' OR
  (NOT EXISTS(SELECT 1 FROM badge_art WHERE id=json_extract(NEW.after_json,'$.image')) AND json_type(NEW.after_json,'$.svg') IS NOT 'text')
 ) AND (
  length(json_extract(NEW.after_json,'$.image'))<>68 OR substr(json_extract(NEW.after_json,'$.image'),1,4)<>'png:' OR
  NOT EXISTS(SELECT 1 FROM admin_badge_png WHERE hash=substr(json_extract(NEW.after_json,'$.image'),5))
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
 INSERT INTO badges(id,name,description,art,price,available,revision,image,png_image)
 SELECT NEW.target_id,json_extract(NEW.after_json,'$.name'),json_extract(NEW.after_json,'$.description'),json_extract(NEW.after_json,'$.art'),json_extract(NEW.after_json,'$.price'),json_extract(NEW.after_json,'$.available'),1,CASE WHEN substr(json_extract(NEW.after_json,'$.image'),1,4)='png:' THEN NULL ELSE json_extract(NEW.after_json,'$.image') END,CASE WHEN substr(json_extract(NEW.after_json,'$.image'),1,4)='png:' THEN substr(json_extract(NEW.after_json,'$.image'),5) ELSE NULL END
 WHERE NEW.action='badge.create';
 UPDATE badges SET name=json_extract(NEW.after_json,'$.name'),description=json_extract(NEW.after_json,'$.description'),art=json_extract(NEW.after_json,'$.art'),price=json_extract(NEW.after_json,'$.price'),available=json_extract(NEW.after_json,'$.available'),revision=revision+1,image=CASE WHEN substr(json_extract(NEW.after_json,'$.image'),1,4)='png:' THEN NULL ELSE json_extract(NEW.after_json,'$.image') END,png_image=CASE WHEN substr(json_extract(NEW.after_json,'$.image'),1,4)='png:' THEN substr(json_extract(NEW.after_json,'$.image'),5) ELSE NULL END
 WHERE id=NEW.target_id AND NEW.action='badge.update';
 UPDATE badges SET is_deleted=1,available=0,revision=revision+1 WHERE id=NEW.target_id AND NEW.action='badge.delete';
END;
