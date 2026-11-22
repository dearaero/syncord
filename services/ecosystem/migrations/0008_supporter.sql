-- Independent entitlements and custom badge capacity. Purchased-badge limits are unchanged.
ALTER TABLE challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'user' CHECK(purpose IN('user','supporter-admin'));
ALTER TABLE challenges ADD COLUMN csrf_hash TEXT;
CREATE TABLE supporter_admin_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),csrf_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)));
CREATE INDEX supporter_admin_expiry ON supporter_admin_sessions(expires_at);
ALTER TABLE badges ADD COLUMN supporter_tier INTEGER NOT NULL DEFAULT 0 CHECK(supporter_tier BETWEEN 0 AND 3);
CREATE UNIQUE INDEX supporter_official_tier ON badges(supporter_tier) WHERE supporter_tier>0;
INSERT INTO badges(id,name,description,art,price,available,supporter_tier) VALUES
 ('supporter-tier-1','Tier 1 Supporter','Syncord Supporter','spark',1,0,1),
 ('supporter-tier-2','Tier 2 Supporter','Syncord Supporter','orbit',1,0,2),
 ('supporter-tier-3','Tier 3 Supporter','Syncord Supporter','shield',1,0,3);
CREATE TRIGGER supporter_official_no_sale BEFORE UPDATE ON badges WHEN NEW.supporter_tier>0 AND (NEW.available<>0 OR NEW.is_deleted<>0 OR NEW.supporter_tier<>OLD.supporter_tier) BEGIN SELECT RAISE(ABORT,'supporter_official_reserved'); END;
CREATE TABLE supporter_entitlements(account_id TEXT PRIMARY KEY REFERENCES accounts(id),tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND 3),suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN(0,1)),revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
CREATE TABLE custom_badges(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 32),description TEXT NOT NULL CHECK(length(description)<=160),
 status TEXT NOT NULL CHECK(status IN('DRAFT','PROCESSING','PENDING_REVIEW','APPROVED','REJECTED','REVOKED')),active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)),image TEXT REFERENCES custom_badge_assets(hash),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 10000),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,submitted_at INTEGER,reason TEXT NOT NULL DEFAULT '',deleted_at INTEGER,lease TEXT
);
CREATE INDEX custom_badge_owner ON custom_badges(account_id,deleted_at);
CREATE INDEX custom_badge_queue ON custom_badges(status,submitted_at);
-- Assets contain only the immutable re-encoded output. Original uploads never enter D1 or R2.
CREATE TABLE custom_badge_assets(hash TEXT PRIMARY KEY CHECK(length(hash)=64),storage_key TEXT NOT NULL UNIQUE,size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 65536),width INTEGER NOT NULL CHECK(width=128),height INTEGER NOT NULL CHECK(height=128),created_at INTEGER NOT NULL);
CREATE TABLE supporter_commands(
 id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES accounts(id),request_key TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('tier','create','edit','process','image','fail','submit','delete','activate','approve','reject','revoke','admin.login','admin.logout')),
 target_id TEXT NOT NULL,expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),request_hash TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL,
 UNIQUE(actor_id,request_key)
);
CREATE TABLE supporter_tier_history(command_id INTEGER PRIMARY KEY REFERENCES supporter_commands(id),account_id TEXT NOT NULL REFERENCES accounts(id),old_tier INTEGER NOT NULL,new_tier INTEGER NOT NULL,old_suspended INTEGER NOT NULL,new_suspended INTEGER NOT NULL);
CREATE TRIGGER supporter_tier_history_no_update BEFORE UPDATE ON supporter_tier_history BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;
CREATE TRIGGER supporter_tier_history_no_delete BEFORE DELETE ON supporter_tier_history BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;
CREATE INDEX supporter_commands_target ON supporter_commands(target_id,id);
CREATE TABLE custom_badge_versions(badge_id TEXT NOT NULL REFERENCES custom_badges(id),revision INTEGER NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,image TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(badge_id,revision));
CREATE TRIGGER custom_badge_capacity BEFORE INSERT ON custom_badges BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM supporter_entitlements WHERE account_id=NEW.account_id AND tier>0 AND suspended=0 AND (SELECT COUNT(*) FROM custom_badges WHERE account_id=NEW.account_id AND deleted_at IS NULL)<tier) THEN RAISE(ABORT,'supporter.capacity') END;
END;
CREATE TRIGGER custom_badge_version_insert AFTER INSERT ON custom_badges BEGIN INSERT INTO custom_badge_versions VALUES(NEW.id,NEW.revision,NEW.name,NEW.description,NEW.image,NEW.status,NEW.updated_at); END;
CREATE TRIGGER custom_badge_version_update AFTER UPDATE OF revision ON custom_badges WHEN NEW.revision<>OLD.revision BEGIN INSERT INTO custom_badge_versions VALUES(NEW.id,NEW.revision,NEW.name,NEW.description,NEW.image,NEW.status,NEW.updated_at); END;
CREATE TRIGGER supporter_command_validate BEFORE INSERT ON supporter_commands WHEN NOT EXISTS(SELECT 1 FROM supporter_commands WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key) BEGIN
 SELECT CASE WHEN NEW.action NOT IN('tier','approve','reject','revoke','admin.login','admin.logout') AND NEW.actor_id<>NEW.owner_id THEN RAISE(ABORT,'supporter.denied') END;
 SELECT CASE WHEN NEW.action IN('approve','reject','revoke') AND NEW.actor_id=NEW.owner_id THEN RAISE(ABORT,'supporter.denied') END;
 SELECT CASE WHEN NEW.action='tier' AND COALESCE((SELECT revision FROM supporter_entitlements WHERE account_id=NEW.owner_id),0)<>NEW.expected_revision THEN RAISE(ABORT,'supporter.conflict') END;
 SELECT CASE WHEN NEW.action IN('edit','process','image','fail','submit','delete','approve','reject','revoke') AND NOT EXISTS(SELECT 1 FROM custom_badges WHERE id=NEW.target_id AND account_id=NEW.owner_id AND deleted_at IS NULL AND revision=NEW.expected_revision) THEN RAISE(ABORT,'supporter.conflict') END;
 SELECT CASE WHEN NEW.action IN('create','edit','process','submit','activate') AND NOT EXISTS(SELECT 1 FROM supporter_entitlements WHERE account_id=NEW.owner_id AND tier>0 AND suspended=0) THEN RAISE(ABORT,'supporter.required') END;
 SELECT CASE WHEN NEW.action IN('edit','process') AND EXISTS(SELECT 1 FROM custom_badges WHERE id=NEW.target_id AND status IN('PROCESSING','PENDING_REVIEW','REVOKED')) THEN RAISE(ABORT,'supporter.locked') END;
 SELECT CASE WHEN NEW.action='submit' AND NOT EXISTS(SELECT 1 FROM custom_badges b JOIN custom_badge_assets a ON a.hash=b.image WHERE b.id=NEW.target_id AND b.status IN('DRAFT','REJECTED')) THEN RAISE(ABORT,'supporter.imageRequired') END;
 SELECT CASE WHEN NEW.action IN('image','fail') AND NOT EXISTS(SELECT 1 FROM custom_badges WHERE id=NEW.target_id AND status='PROCESSING' AND lease=json_extract(NEW.payload,'$.lease')) THEN RAISE(ABORT,'supporter.conflict') END;
 SELECT CASE WHEN NEW.action='image' AND NOT EXISTS(SELECT 1 FROM custom_badge_assets WHERE hash=json_extract(NEW.payload,'$.image')) THEN RAISE(ABORT,'supporter.invalidImage') END;
 SELECT CASE WHEN NEW.action IN('approve','reject') AND NOT EXISTS(SELECT 1 FROM custom_badges b JOIN custom_badge_assets a ON a.hash=b.image WHERE b.id=NEW.target_id AND b.status='PENDING_REVIEW') THEN RAISE(ABORT,'supporter.conflict') END;
 SELECT CASE WHEN NEW.action='revoke' AND NOT EXISTS(SELECT 1 FROM custom_badges WHERE id=NEW.target_id AND status='APPROVED') THEN RAISE(ABORT,'supporter.conflict') END;
 SELECT CASE WHEN NEW.action='activate' AND (json_array_length(NEW.payload)>COALESCE((SELECT tier FROM supporter_entitlements WHERE account_id=NEW.owner_id AND suspended=0),0) OR EXISTS(SELECT 1 FROM json_each(NEW.payload) j WHERE NOT EXISTS(SELECT 1 FROM custom_badges WHERE id=j.value AND account_id=NEW.owner_id AND deleted_at IS NULL AND status='APPROVED'))) THEN RAISE(ABORT,'supporter.denied') END;
END;
CREATE TRIGGER supporter_command_apply AFTER INSERT ON supporter_commands BEGIN
 INSERT INTO supporter_tier_history SELECT NEW.id,NEW.owner_id,COALESCE((SELECT tier FROM supporter_entitlements WHERE account_id=NEW.owner_id),0),json_extract(NEW.payload,'$.tier'),COALESCE((SELECT suspended FROM supporter_entitlements WHERE account_id=NEW.owner_id),0),json_extract(NEW.payload,'$.suspended') WHERE NEW.action='tier';
 INSERT INTO supporter_entitlements(account_id,tier,suspended,revision,updated_at) SELECT NEW.owner_id,json_extract(NEW.payload,'$.tier'),json_extract(NEW.payload,'$.suspended'),1,NEW.created_at WHERE NEW.action='tier' ON CONFLICT(account_id) DO UPDATE SET tier=excluded.tier,suspended=excluded.suspended,revision=supporter_entitlements.revision+1,updated_at=excluded.updated_at;
 -- Stable creation order decides which active badges survive a downgrade. Records/assets are retained.
 UPDATE custom_badges SET active=0 WHERE account_id=NEW.owner_id AND NEW.action='tier' AND id NOT IN(SELECT id FROM custom_badges WHERE account_id=NEW.owner_id AND active=1 AND deleted_at IS NULL ORDER BY created_at,id LIMIT (SELECT CASE WHEN suspended=1 THEN 0 ELSE tier END FROM supporter_entitlements WHERE account_id=NEW.owner_id));
 INSERT INTO custom_badges(id,account_id,name,description,status,revision,created_at,updated_at) SELECT NEW.target_id,NEW.owner_id,json_extract(NEW.payload,'$.name'),json_extract(NEW.payload,'$.description'),'DRAFT',1,NEW.created_at,NEW.created_at WHERE NEW.action='create';
 UPDATE custom_badges SET name=json_extract(NEW.payload,'$.name'),description=json_extract(NEW.payload,'$.description'),status='DRAFT',active=0,reason='',revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action='edit';
 UPDATE custom_badges SET status='PROCESSING',active=0,lease=json_extract(NEW.payload,'$.lease'),revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action='process';
 UPDATE custom_badges SET status='DRAFT',image=CASE WHEN NEW.action='image' THEN json_extract(NEW.payload,'$.image') ELSE image END,lease=NULL,revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action IN('image','fail');
 UPDATE custom_badges SET status='PENDING_REVIEW',active=0,reason='',submitted_at=NEW.created_at,revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action='submit';
 UPDATE custom_badges SET deleted_at=NEW.created_at,active=0,revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action='delete';
 UPDATE custom_badges SET active=CASE WHEN id IN(SELECT value FROM json_each(NEW.payload)) THEN 1 ELSE 0 END WHERE account_id=NEW.owner_id AND NEW.action='activate';
 UPDATE custom_badges SET status=CASE NEW.action WHEN 'approve' THEN 'APPROVED' WHEN 'reject' THEN 'REJECTED' ELSE 'REVOKED' END,active=0,reason=json_extract(NEW.payload,'$.reason'),revision=revision+1,updated_at=NEW.created_at WHERE id=NEW.target_id AND NEW.action IN('approve','reject','revoke');
END;
CREATE TRIGGER supporter_audit_no_update BEFORE UPDATE ON supporter_commands BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;
CREATE TRIGGER supporter_audit_no_delete BEFORE DELETE ON supporter_commands BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;
CREATE TRIGGER custom_asset_no_update BEFORE UPDATE ON custom_badge_assets BEGIN SELECT RAISE(ABORT,'supporter.assetImmutable'); END;
CREATE TRIGGER custom_asset_no_delete BEFORE DELETE ON custom_badge_assets BEGIN SELECT RAISE(ABORT,'supporter.assetImmutable'); END;
CREATE TRIGGER custom_version_no_update BEFORE UPDATE ON custom_badge_versions BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;
CREATE TRIGGER custom_version_no_delete BEFORE DELETE ON custom_badge_versions BEGIN SELECT RAISE(ABORT,'supporter.auditImmutable'); END;

DROP TRIGGER admin_validate;
CREATE TRIGGER admin_validate BEFORE INSERT ON admin_audit
WHEN NOT EXISTS(SELECT 1 FROM admin_audit WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key)
BEGIN
 SELECT CASE WHEN NEW.action='badge.create' AND (NEW.expected_revision<>0 OR EXISTS(SELECT 1 FROM badges WHERE id=NEW.target_id)) THEN RAISE(ABORT,'admin_badge_exists') END;
 SELECT CASE WHEN NEW.action='badge.create' AND (SELECT COUNT(*) FROM badges WHERE is_deleted=0 AND supporter_tier=0)>=512 THEN RAISE(ABORT,'admin_catalog_full') END;
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
