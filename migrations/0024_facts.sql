-- Facts about the user (PLAN §6.26, ROADMAP block H part 18, 2026-10-07).
--
-- "תזכור עליי שאני גר ברחובות". Unlike notes, the model sees these: they go
-- into every agent turn as "About the user", so it understands better. That is
-- the user's decision, and an amendment to invariant 2. A fact is checked
-- before it is saved: no email, link, phone number, code or long number.
--
-- AES-GCM ciphertext, bound to the principal and the row. `chars` is the
-- plaintext length, kept in the clear for the 800-character total cap.

CREATE TABLE facts (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  chars      INTEGER NOT NULL CHECK (chars > 0),
  created_at INTEGER NOT NULL
);

CREATE INDEX facts_by_principal ON facts (principal, created_at);
