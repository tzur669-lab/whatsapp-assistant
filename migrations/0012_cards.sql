-- Action cards (PLAN §6.20).
--
-- A phone action (an alarm, a timer, a message to compose) is not run by the
-- server. It is written down as a pending action with `channel = 'card'`, sent
-- to the app as a card, and run on the phone only after a signed claim consumes
-- the row — once. A card row is never reachable from the chat confirmation
-- paths ("כן", a typed code, a chat button), and a chat row never from a claim.
--
-- app_outbox.action_json: the card riding on a reply. Its type, id, nonce and
-- code-rendered preview — never the parameters, which the phone receives only
-- from the claim.
--
-- devices.caps: what the paired app says it can do, from its signed push-token
-- update. An app that never said `cards` is never offered a card tool.

ALTER TABLE pending_actions ADD COLUMN channel TEXT NOT NULL DEFAULT 'chat';

ALTER TABLE app_outbox ADD COLUMN action_json TEXT;

ALTER TABLE devices ADD COLUMN caps TEXT;
