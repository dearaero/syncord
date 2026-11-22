PRAGMA foreign_keys = ON;
CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar TEXT, created_at INTEGER NOT NULL);
CREATE TABLE wallets (account_id TEXT PRIMARY KEY REFERENCES accounts(id), balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(balance)='integer' AND balance BETWEEN 0 AND 9000000000000));
CREATE TABLE badges (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, art TEXT NOT NULL CHECK(art IN ('spark','orbit','shield','compass')), price INTEGER NOT NULL CHECK(typeof(price)='integer' AND price BETWEEN 1 AND 1000000), available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)));
CREATE TABLE sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)));
CREATE INDEX session_account ON sessions(account_id);
CREATE TABLE challenges (poll_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL UNIQUE, expected_id TEXT NOT NULL, verified_id TEXT, verifier TEXT NOT NULL, browser_hash TEXT, consumed INTEGER NOT NULL DEFAULT 0, failure TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE purchases (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), badge_id TEXT NOT NULL REFERENCES badges(id), price INTEGER NOT NULL, request_key TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(account_id,request_key), UNIQUE(account_id,badge_id));
CREATE TABLE owned_badges (account_id TEXT NOT NULL REFERENCES accounts(id), badge_id TEXT NOT NULL REFERENCES badges(id), purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id), active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)), PRIMARY KEY(account_id,badge_id));
CREATE TABLE reward_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 1000000), once_per_account INTEGER NOT NULL DEFAULT 1 CHECK(once_per_account IN(0,1)), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)));
CREATE TABLE reward_grants (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), rule_id TEXT NOT NULL REFERENCES reward_rules(id), event_id TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(rule_id,event_id));
CREATE INDEX reward_account_rule ON reward_grants(account_id,rule_id);
CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id), delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta<>0), balance_after INTEGER NOT NULL CHECK(balance_after>=0), reason TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE INDEX ledger_account_page ON ledger(account_id,id DESC);
CREATE TABLE request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TRIGGER create_wallet AFTER INSERT ON accounts BEGIN INSERT INTO wallets(account_id) VALUES(NEW.id); END;
CREATE TRIGGER validate_purchase BEFORE INSERT ON purchases BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM badges WHERE id=NEW.badge_id AND available=1 AND price=NEW.price) THEN RAISE(ABORT,'badge_unavailable') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM owned_badges WHERE account_id=NEW.account_id AND badge_id=NEW.badge_id) THEN RAISE(ABORT,'already_owned') END;
 SELECT CASE WHEN COALESCE((SELECT balance FROM wallets WHERE account_id=NEW.account_id),-1)<NEW.price THEN RAISE(ABORT,'insufficient_points') END;
END;
CREATE TRIGGER apply_purchase AFTER INSERT ON purchases BEGIN
 UPDATE wallets SET balance=balance-NEW.price WHERE account_id=NEW.account_id;
 INSERT INTO owned_badges(account_id,badge_id,purchase_id) VALUES(NEW.account_id,NEW.badge_id,NEW.id);
 INSERT INTO ledger(account_id,delta,balance_after,reason,reference,created_at) SELECT NEW.account_id,-NEW.price,balance,'Badge purchase', 'purchase:'||NEW.id,NEW.created_at FROM wallets WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER active_badge_limit BEFORE UPDATE OF active ON owned_badges WHEN NEW.active=1 AND OLD.active=0 BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM owned_badges WHERE account_id=NEW.account_id AND active=1)>=3 THEN RAISE(ABORT,'active_badge_limit') END;
END;
CREATE TRIGGER validate_reward BEFORE INSERT ON reward_grants BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM reward_rules WHERE id=NEW.rule_id AND enabled=1 AND amount=NEW.amount) THEN RAISE(ABORT,'invalid_reward') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM reward_rules r JOIN reward_grants g ON r.id=g.rule_id WHERE r.id=NEW.rule_id AND r.once_per_account=1 AND g.account_id=NEW.account_id) THEN RAISE(ABORT,'reward_already_granted') END;
END;
CREATE TRIGGER apply_reward AFTER INSERT ON reward_grants BEGIN
 UPDATE wallets SET balance=balance+NEW.amount WHERE account_id=NEW.account_id;
 INSERT INTO ledger(account_id,delta,balance_after,reason,reference,created_at) SELECT NEW.account_id,NEW.amount,balance,(SELECT name FROM reward_rules WHERE id=NEW.rule_id),'reward:'||NEW.id,NEW.created_at FROM wallets WHERE account_id=NEW.account_id;
END;
INSERT INTO badges VALUES ('first-light','First Light','A spark for the beginning of your Syncord journey.','spark',25,1),('orbital','Orbital','A small orbit with a big point of view.','orbit',100,1),('guardian','Guardian','For the people who help the community grow.','shield',250,1),('pathfinder','Pathfinder','Keep exploring the Syncord ecosystem.','compass',500,1);
INSERT INTO reward_rules VALUES('verified-welcome','Discord verification reward',50,1,1),('community-contribution','Verified community contribution',25,0,1);
