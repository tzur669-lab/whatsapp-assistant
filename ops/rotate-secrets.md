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
| `LOG_HASH_KEY` | Self-generated | Changing it breaks correlation with older log lines, by design |

## `TOKEN_ENC_KEY` rotation

The key is versioned so rotation is additive:

1. Add `TOKEN_ENC_KEY_V2`.
2. Re-encrypt stored tokens, writing `key_version = 2`.
3. Only once no row references version 1, remove `TOKEN_ENC_KEY_V1`.
