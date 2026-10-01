# Rotating secrets

Rotate on a schedule, and immediately after any suspected exposure.

## Order of operations

1. Create the new value at the provider.
2. `wrangler secret put <NAME> --env production`
3. Verify with a live smoke test from the phone.
4. Revoke the old value at the provider.

Steps 2 and 4 are never swapped — revoking first causes an outage.

## Per secret

| Secret | Where to rotate | Notes |
|---|---|---|
| `WA_APP_SECRET` | Meta app → Settings → Basic | Invalidates in-flight webhook signatures; Meta retries |
| `WA_VERIFY_TOKEN` | Self-generated, ≥32 random bytes | Re-run the webhook handshake in the Meta dashboard afterwards |
| `WA_ACCESS_TOKEN` | Meta Business → System Users | Scope must stay `whatsapp_business_messaging` only |
| `GROQ_API_KEY` | Groq console | Confirm Zero Data Retention is still on |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials | Existing refresh tokens survive a client-secret rotation |
| `TOKEN_ENC_KEY_V1` | Self-generated AES-256 key | Add `TOKEN_ENC_KEY_V2` and re-encrypt; never edit V1 in place |
| `LOG_HASH_KEY` | Self-generated | **Do not rotate casually.** It keys the log hash *and the principal every record belongs to*: a new value orphans every reminder, the paired phone and the Google connection. Rotate only after a leak, and then plan to reconnect Google, re-pair the phone, and re-create pending reminders |
| `ALLOWLIST_WA_IDS` | Not a secret to rotate | Never change or reorder it: its first entry is the identity (PLAN §6.18), on the app channel too. It is no longer the kill switch — `CHANNEL=off` is, see `ops/revoke-tokens.md` |
| `DEVICE_TOKEN_PEPPER` | Self-generated | Keys the hashes of used pairing codes and public keys. Rotating it lets a used bootstrap code work once more — set a new `PAIR_BOOTSTRAP_CODE` in the same step |
| `PAIR_BOOTSTRAP_CODE` | `scripts/set-staging-secrets.ps1 -PairCode` | Each value pairs one phone and then never works again. Setting a new one is how a replacement phone is paired; pairing revokes the old one |

## `TOKEN_ENC_KEY` rotation

The key is versioned so rotation is additive rather than a migration that could
strand every stored token. Ciphertext carries its own version
(`enc.<version>.<base64>`), the keyring reads every `TOKEN_ENC_KEY_V<n>` present,
and new writes always use the **highest** version available.

1. Generate a new 32-byte key and set it as `TOKEN_ENC_KEY_V2`.
   Both keys are now live: V2 for writes, V1 still readable.
2. Re-encrypt by **reconnecting**: send `/connect google`, grant again. The new
   refresh token is written under V2 and the old row is replaced.
   There is deliberately no bulk re-encryption tool — there is exactly one token
   in this system, and a tool that decrypts every secret at once is a worse
   thing to own than a two-minute manual step.
3. Confirm: the `integrations` row's `refresh_token_enc` starts with `enc.2.`.
4. Only then remove `TOKEN_ENC_KEY_V1`.

Removing V1 while a row still references it does not silently fail: the decrypt
throws, the integration marks itself `disconnected` with `E_TOKEN_UNREADABLE`,
and the next calendar request says to reconnect. Recoverable, but visible —
which is the intent.

**Never edit V1 in place.** Overwriting it makes existing ciphertext
undecryptable with no path back.

The agent's conversation history (`conversation_turns`, PLAN §6.19) is encrypted
with the same keyring. It is not re-encrypted: once V1 is removed, its rows no
longer decrypt and are deleted on the next read — the chat simply starts fresh.
That is intended; the history lives 12 hours at most anyway.
