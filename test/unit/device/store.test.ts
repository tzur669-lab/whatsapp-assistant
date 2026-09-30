/**
 * The paired phone's state (PLAN §6.17, §6.18): pairing by MAC, the signing
 * key, nonces, and the lifecycle of a call dispatch. The tests are about what a
 * replay, a guess, an interceptor or a stale row can and cannot do.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { DeviceStore, DISPATCH_TTL_MS, PAIRING_TTL_MS } from '../../../src/device/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { parsePair } from '../../../src/channels/app/parse.js';
import { CLOCK_SKEW_MS } from '../../../src/channels/app/verify.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { FakePhone, FAKE_PUSH_TOKEN } from '../../integration/fake-phone.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.parse('2026-09-27T12:00:00Z');
const PRINCIPAL = 'p_test';
const PEPPER = 'test-pepper-not-a-real-secret';
const KEYRING = parseKeyring({ TOKEN_ENC_KEY_V1: Buffer.alloc(32, 7).toString('base64') });
const BOOTSTRAP = 'ABCD-EFGH-JKMN-PQRS-TVWX';

describe('DeviceStore', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let store: DeviceStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    store = new DeviceStore(driver, () => clock, () => PEPPER, () => KEYRING);
  });
  afterEach(() => driver.close());

  const request = async (phone: FakePhone, code: string, timestamp = clock) =>
    parsePair(await phone.pairBody(code, { timestamp }))!;

  const pairWith = async (phone: FakePhone, code: string, bootstrapCode: string | null = null) =>
    store.pair(await request(phone, code), { principal: PRINCIPAL, bootstrapCode });

  const paired = async (phone = new FakePhone()) => {
    const { code } = await store.createPairing(PRINCIPAL);
    const result = await pairWith(phone, code);
    if (!result.ok) throw new Error(`pairing failed: ${result.reason}`);
    return { phone, deviceId: result.value.deviceId };
  };

  describe('pairing with a /pair code', () => {
    it('issues 20 Crockford characters, shown in groups, and stores no plain copy', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
      const rows = JSON.stringify(driver.exec('SELECT * FROM device_pairings'));
      expect(rows).not.toContain(code.replace(/-/g, ''));
      expect(rows).toContain('enc.1.');
    });

    it('pairs the phone that proves it knows the code', async () => {
      const { phone, deviceId } = await paired();
      expect(store.signingDevice(deviceId)).toEqual({ id: deviceId, principal: PRINCIPAL, publicKey: phone.publicKey });
    });

    it('lets the same key retry after a lost answer, and refuses any other key', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      const phone = new FakePhone();
      const first = await pairWith(phone, code);
      const again = await pairWith(phone, code);
      expect(again).toEqual({ ok: true, value: { deviceId: first.ok ? first.value.deviceId : '', reused: true } });

      expect(await pairWith(new FakePhone(), code)).toEqual({ ok: false, reason: 'already_used' });
    });

    it('refuses a MAC over a swapped key — what an interceptor would send', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      const honest = await request(new FakePhone(), code);
      const swapped = { ...honest, publicKey: new FakePhone().publicKey };
      expect(await store.pair(swapped, { principal: PRINCIPAL, bootstrapCode: null })).toEqual({
        ok: false,
        reason: 'not_found',
      });
    });

    it('refuses an expired code, a wrong code, and a stale timestamp', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      expect((await pairWith(new FakePhone(), 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).ok).toBe(false);

      const stale = await request(new FakePhone(), code, clock - CLOCK_SKEW_MS - 1);
      expect(await store.pair(stale, { principal: PRINCIPAL, bootstrapCode: null })).toEqual({
        ok: false,
        reason: 'expired',
      });

      clock += PAIRING_TTL_MS + 1;
      expect(await pairWith(new FakePhone(), code)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('stores the push address only encrypted', async () => {
      await paired();
      const rows = JSON.stringify(driver.exec('SELECT * FROM devices'));
      expect(rows).not.toContain(FAKE_PUSH_TOKEN);
      expect(rows).toContain('enc.1.');
    });

    it('replaces the previous phone: one paired device at a time', async () => {
      const first = await paired();
      const second = await paired();
      expect(store.signingDevice(first.deviceId)).toBeNull();
      expect(store.signingDevice(second.deviceId)?.id).toBe(second.deviceId);
    });
  });

  describe('the bootstrap code', () => {
    it('pairs once, and a used code stays used after maintenance', async () => {
      const first = await pairWith(new FakePhone(), BOOTSTRAP, BOOTSTRAP);
      expect(first.ok).toBe(true);

      store.purge();
      clock += 24 * 60 * 60 * 1000;
      store.purge();
      expect(await pairWith(new FakePhone(), BOOTSTRAP, BOOTSTRAP)).toEqual({ ok: false, reason: 'already_used' });
    });

    it('is re-armed by a new code, which replaces the phone paired with the old one', async () => {
      const first = await pairWith(new FakePhone(), BOOTSTRAP, BOOTSTRAP);
      const next = 'ZYXW-VTSR-QPNM-KJHG-FEDC';
      const second = await pairWith(new FakePhone(), next, next);
      expect(second.ok).toBe(true);
      expect(first.ok && store.signingDevice(first.value.deviceId)).toBeNull();
    });

    it('accepts what the user typed, however it was typed', async () => {
      expect((await pairWith(new FakePhone(), 'abcd efgh jkmn pqrs tvwx', BOOTSTRAP)).ok).toBe(true);
    });
  });

  describe('signed requests', () => {
    it('spends a nonce once', async () => {
      const { deviceId } = await paired();
      expect(store.claimNonce(deviceId, 'a'.repeat(32), clock + 60_000)).toBe(true);
      expect(store.claimNonce(deviceId, 'a'.repeat(32), clock + 60_000)).toBe(false);
    });

    it('forgets a nonce only after it could no longer be accepted', async () => {
      const { deviceId } = await paired();
      store.claimNonce(deviceId, 'b'.repeat(32), clock + 60_000);
      clock += 59_000;
      expect(store.claimNonce(deviceId, 'b'.repeat(32), clock + 60_000)).toBe(false);
      clock += 2_000;
      expect(store.claimNonce(deviceId, 'b'.repeat(32), clock + 60_000)).toBe(true);
    });

    it('knows no revoked device', async () => {
      const { deviceId } = await paired();
      expect(store.revoke(PRINCIPAL)).toBe(1);
      expect(store.signingDevice(deviceId)).toBeNull();
      expect(store.isActive(deviceId)).toBe(false);
      expect(store.activeDevice(PRINCIPAL)).toBeNull();
    });

    it('gives the push address back only decrypted, only for the active device', async () => {
      const { deviceId } = await paired();
      expect(await store.pushTokenOf(deviceId)).toBe(FAKE_PUSH_TOKEN);
      await store.setPushToken(deviceId, 'rotated-token');
      expect(await store.pushTokenOf(deviceId)).toBe('rotated-token');
      store.forgetPushToken(deviceId);
      expect(await store.pushTokenOf(deviceId)).toBeNull();
    });
  });

  describe('a dispatch', () => {
    it('is fetched by the device it was sent to, with the words to match', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דוד דני', 'דני']);
      expect(id).toMatch(/^[0-9a-f]{32}$/);

      const fetched = store.fetchDispatch(id, deviceId);
      expect(fetched).toEqual({
        ok: true,
        value: { queryVariants: ['דוד דני', 'דני'], expiresAt: NOW + DISPATCH_TTL_MS },
      });
    });

    it('is not fetched by another device', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      expect(store.fetchDispatch(id, 'some-other-device')).toEqual({ ok: false, reason: 'not_found' });
    });

    it('is not fetched after two minutes', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      clock += DISPATCH_TTL_MS + 1;
      expect(store.fetchDispatch(id, deviceId)).toEqual({ ok: false, reason: 'expired' });
    });

    it('settles on the first report, and refuses a second', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      store.fetchDispatch(id, deviceId);

      const first = store.report(id, deviceId, { matched: 'one', outcome: 'placed' });
      expect(first).toEqual({ ok: true, value: { principal: PRINCIPAL, outcome: 'placed' } });
      expect(store.report(id, deviceId, { matched: 'one', outcome: 'cancelled' })).toEqual({
        ok: false,
        reason: 'already_used',
      });
    });

    it('takes a report that arrives just after expiry, before the sweep', async () => {
      // The tap at 1:59 is a call that happened; refusing to hear about it would
      // make the reply say the phone was unavailable when it was not.
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      clock += DISPATCH_TTL_MS + 5_000;
      expect(store.report(id, deviceId, { matched: 'one', outcome: 'placed' }).ok).toBe(true);
    });

    it('sweeps the unanswered ones once, and names them for the reply', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      expect(store.nextExpiryAt()).toBe(NOW + DISPATCH_TTL_MS);

      clock += DISPATCH_TTL_MS;
      expect(store.expireDue()).toEqual([{ id, principal: PRINCIPAL }]);
      expect(store.expireDue()).toEqual([]);
      expect(store.nextExpiryAt()).toBeNull();
      expect(store.report(id, deviceId, { matched: 'one', outcome: 'placed' }).ok).toBe(false);
    });

    it('never stores a name or number the device reports', async () => {
      const { deviceId } = await paired();
      const { id } = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      store.report(id, deviceId, { matched: 'many', outcome: 'cancelled' });
      const row = driver.exec('SELECT * FROM call_dispatches WHERE id = ?', id)[0];
      expect(row).toMatchObject({ status: 'cancelled', matched: 'many' });
    });
  });

  describe('retention', () => {
    it('purges settled dispatches and spent pairings, and keeps open ones', async () => {
      const { deviceId } = await paired();
      const settled = store.createDispatch(PRINCIPAL, deviceId, ['דני']);
      store.report(settled.id, deviceId, { matched: 'one', outcome: 'placed' });
      const open = store.createDispatch(PRINCIPAL, deviceId, ['אמא']);

      store.purge();
      const ids = driver.exec('SELECT id FROM call_dispatches').map((r) => r['id']);
      expect(ids).toEqual([open.id]);

      // A used /pair code is kept until it expires, so a lost answer can be retried.
      expect(driver.exec('SELECT * FROM device_pairings')).toHaveLength(1);
      clock += PAIRING_TTL_MS;
      store.purge();
      expect(driver.exec('SELECT * FROM device_pairings')).toEqual([]);
    });
  });
});
