-- Signaling metadata only; never file bytes, paths or Discord credentials.
CREATE TABLE drop_invites (
 id TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES accounts(id), receiver TEXT NOT NULL REFERENCES accounts(id),
 name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0 AND size<=9007199254740991),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined','cancelled','connected')),
 offer TEXT, answer TEXT, created_at INTEGER NOT NULL, expires INTEGER NOT NULL,
 CHECK(sender<>receiver)
);
CREATE INDEX drop_sender_time ON drop_invites(sender,created_at);
CREATE INDEX drop_receiver_time ON drop_invites(receiver,created_at);
