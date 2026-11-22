-- Web-admin authentication/allowlist/MFA/CSRF remains mandatory in the Worker.
-- Permit an authenticated administrator to moderate their own badge.
-- Keep all existing revision, state, capacity, ownership and immutable audit guards.
DROP TRIGGER supporter_command_validate;
CREATE TRIGGER supporter_command_validate BEFORE INSERT ON supporter_commands WHEN NOT EXISTS(SELECT 1 FROM supporter_commands WHERE actor_id=NEW.actor_id AND request_key=NEW.request_key) BEGIN
 SELECT CASE WHEN NEW.action NOT IN('tier','approve','reject','revoke','admin.login','admin.logout') AND NEW.actor_id<>NEW.owner_id THEN RAISE(ABORT,'supporter.denied') END;
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
