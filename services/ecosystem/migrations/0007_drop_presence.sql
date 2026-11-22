-- Short-lived Drop availability, bound to the verified Ecosystem session.
-- Each client document owns a lease; stopping one device cannot disable another.
CREATE TABLE drop_presence (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
 lease TEXT NOT NULL,
 expires INTEGER NOT NULL,
 PRIMARY KEY(account_id,session_hash,lease)
);
CREATE INDEX drop_presence_expiry ON drop_presence(expires);
