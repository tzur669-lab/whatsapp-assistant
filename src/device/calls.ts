/**
 * Send one "call X" to the paired phone (PLAN §6.17).
 *
 * The Worker's whole part in a call: find the paired device, write a dispatch
 * that expires in two minutes, and push its opaque id. Matching the words to a
 * contact, showing the resolved number, and dialling all happen on the phone,
 * behind a tap on its own screen — the Tier 3 factor.
 */
import type { Logger } from '../security/redact.js';
import type { DeviceStore } from './store.js';
import type { PushResult } from './fcm.js';

export type DispatchResult =
  | { ok: true; dispatchId: string }
  | { ok: false; reason: 'no_device' | 'push_failed' };

export interface CallDispatcher {
  dispatch(principal: string, queryVariants: readonly string[]): Promise<DispatchResult>;
}

export function createCallDispatcher(deps: {
  store: DeviceStore;
  push: { send(pushToken: string, dispatchId: string): Promise<PushResult> };
  log: Logger;
}): CallDispatcher {
  return {
    async dispatch(principal, queryVariants) {
      const device = deps.store.activeDevice(principal);
      if (!device) return { ok: false, reason: 'no_device' };

      const pushToken = await deps.store.pushTokenOf(device.id);
      if (!pushToken) {
        deps.log.warn('call_push_failed', { errorCode: 'E_PUSH_TOKEN_MISSING' });
        return { ok: false, reason: 'push_failed' };
      }

      const { id } = deps.store.createDispatch(principal, device.id, queryVariants);
      const pushed = await deps.push.send(pushToken, id);
      if (!pushed.ok) {
        // Settled now, so the expiry sweep does not send a second reply.
        deps.store.markFailed(id);
        deps.log.warn('call_push_failed', {
          dispatchId: id,
          errorCode: `E_PUSH_${pushed.reason.toUpperCase()}`,
          ...(pushed.status === undefined ? {} : { status: pushed.status }),
        });
        return { ok: false, reason: 'push_failed' };
      }

      deps.log.info('call_dispatched', { dispatchId: id, variants: queryVariants.length });
      return { ok: true, dispatchId: id };
    },
  };
}
