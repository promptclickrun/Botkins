CREATE TABLE profiles (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  credential TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, profile TEXT NOT NULL REFERENCES profiles(id), label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status_key TEXT NOT NULL UNIQUE
);
CREATE INDEX profile_devices ON devices(profile);
CREATE TABLE hosts (
  profile TEXT NOT NULL REFERENCES profiles(id), server_id TEXT NOT NULL, server_key TEXT NOT NULL,
  name TEXT NOT NULL, routes TEXT NOT NULL, member INTEGER NOT NULL, PRIMARY KEY(profile, server_id)
);
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY, verifier_hash TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'new',
  device TEXT NOT NULL, browser_hash TEXT, guesses INTEGER NOT NULL DEFAULT 0,
  mode TEXT, challenge TEXT, profile TEXT, name TEXT, email TEXT,
  credential TEXT, public_key TEXT, counter INTEGER, otp_hash TEXT, otp_until INTEGER,
  otp_tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX enroll_expiry ON enrollments(expires);
CREATE INDEX enroll_pending ON enrollments(profile, state, expires);
CREATE TABLE admission (day INTEGER PRIMARY KEY, started INTEGER NOT NULL);
CREATE TABLE mail (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, recipient TEXT NOT NULL, flow TEXT NOT NULL);
CREATE INDEX mail_window ON mail(at);
CREATE INDEX mail_recipient ON mail(recipient, at);
CREATE INDEX mail_flow ON mail(flow, at);
CREATE TABLE proofs (
  hash TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, server_id TEXT NOT NULL, server_key TEXT NOT NULL, public_key TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX proof_expiry ON proofs(expires);
CREATE INDEX proof_device ON proofs(device);
