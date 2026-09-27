/**
 * The device companion's state (PLAN §6.17): pairing, the device token, and the
 * lifecycle of a call dispatch. Every credential here is a bearer secret, so the
 * tests are about what a replay, a guess or a stale row can and cannot do.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { DeviceStore, DISPATCH_TTL_MS, PAIRING_TTL_MS } from '../../../src/device/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

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
const PUSH = 'fake-fcm-registration-token';

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

  const paired = async () => {
    const { code } = await store.createPairing(PRINCIPAL);
    const result = await store.pair(code, PUSH);
    if (!result.ok) throw new Error(`pairing failed: ${result.reason}`);
    return result.value;
  };

  describe('pairing', () => {
    it('issues a 256-bit code and stores only its hash', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(driver.exec('SELECT * FROM device_pairings'))).not.toContain(code);
    });

    it('trades the code for a device token, once', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      const first = await store.pair(code, PUSH);
      expect(first.ok).toBe(true);
      expect(await store.pair(code, PUSH)).toEqual({ ok: false, reason: 'already_used' });
    });

    it('refuses an expired code', async () => {
      const { code } = await store.createPairing(PRINCIPAL);
      clock += PAIRING_TTL_MS + 1;
      expect(await store.pair(code, PUSH)).toEqual({ ok: false, reason: 'expired' });
    });

    it('refuses a code it never issued', async () => {
      const result = await store.pair('A'.repeat(43), PUSH);
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('stores the device token only as a hash, and the push address only encrypted', async () => {
      const { deviceToken } = await paired();
      const rows = JSON.stringify(driver.exec('SELECT * FROM devices'));
      expect(rows).not.toContain(deviceToken);
      expect(rows).not.toContain(PUSH);
      expect(rows).toContain('enc.1.');
    });

    it('replaces the previous phone: one paired device at a time', async () => {
      const first = await paired();
      const second = await paired();
      expect(await store.authenticate(first.deviceToken)).toBeNull();
      expect((await store.authenticate(second.deviceToken))?.id).toBe(second.deviceId);
    });
  });

  describe('the device token', () => {
    it('authenticates the paired device', async () => {
      const { deviceToken, deviceId } = await paired();
      const device = await store.authenticate(deviceToken);
      expect(device).toMatchObject({ id: deviceId, principal: PRINCIPAL });
    });

    it('refuses a wrong token and a malformed one', async () => {
      await paired();
      expect(await store.authenticate('B'.repeat(43))).toBeNull();
      expect(await store.authenticate('not a token')).toBeNull();
      expect(await store.authenticate('')).toBeNull();
    });

    it('refuses every token after /pair off', async () => {
      const { deviceToken } = await paired();
      expect(store.revoke(PRINCIPAL)).toBe(1);
      expect(await store.authenticate(deviceToken)).toBeNull();
      expect(store.activeDevice(PRINCIPAL)).toBeNull();
    });

    it('gives the push address back only decrypted, only for the active device', async () => {
      const { deviceId } = await paired();
      expect(await store.pushTokenOf(deviceId)).toBe(PUSH);
      await store.setPushToken(deviceId, 'rotated-token');
      expect(await store.pushTokenOf(deviceId)).toBe('rotated-token');
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
      expect(driver.exec('SELECT * FROM device_pairings')).toEqual([]);
    });
  });
});
