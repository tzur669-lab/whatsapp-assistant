/**
 * The registry is the single source of truth for what the assistant can do
 * (PLAN §6.4). These are drift guards: each one fails the build for a mistake
 * that would otherwise only show up as a bad reply in production.
 */
import { describe, expect, it } from 'vitest';
import { REGISTRY, TOOL_NAMES, toolCatalog } from '../../../src/tools/registry.js';
import { REMINDER_TOOLS } from '../../../src/tools/reminders.js';
import { calendarListEvents } from '../../../src/tools/calendar-read.js';
import { CALENDAR_WRITE_TOOLS } from '../../../src/tools/calendar-write.js';
import { callsPlace } from '../../../src/tools/calls.js';
import { PHONE_ACTION_TOOLS } from '../../../src/tools/phone-actions.js';
import { PHONE_READ_TOOLS } from '../../../src/tools/phone-reads.js';
import { infoLookup } from '../../../src/tools/lookup.js';
import type { ToolDefinition } from '../../../src/tools/types.js';
import { INTENT_NAMES } from '../../../src/nlu/intent-schema.js';

const IMPLEMENTATIONS: Record<string, ToolDefinition> = {
  ...REMINDER_TOOLS,
  'calendar.list_events': calendarListEvents,
  ...CALENDAR_WRITE_TOOLS,
  'calls.place': callsPlace,
  ...(PHONE_ACTION_TOOLS as Record<string, ToolDefinition>),
  ...(PHONE_READ_TOOLS as Record<string, ToolDefinition>),
  'info.lookup': infoLookup,
};

describe('every registered tool is real', () => {
  it('has an implementation', () => {
    // Without this, adding a tool to the registry and forgetting the body ships
    // a bot that parses the request and then says "not available yet".
    const missing = TOOL_NAMES.filter((name) => !IMPLEMENTATIONS[name]);
    expect(missing).toEqual([]);
  });

  it('implements no tool that is not registered', () => {
    const stray = Object.keys(IMPLEMENTATIONS).filter(
      (name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]),
    );
    expect(stray).toEqual([]);
  });

  it('names itself the same in the registry and in its definition', () => {
    for (const name of TOOL_NAMES) {
      expect(IMPLEMENTATIONS[name]?.name).toBe(name);
    }
  });

  it('gives every Tier 1 tool a way back', () => {
    // Tier 1 means "create, reversible". A Tier 1 tool with no undo is a
    // contradiction, and the policy engine would offer a button that does nothing.
    for (const name of TOOL_NAMES) {
      // A card's way back is on the phone itself, and policy never offers a
      // server Undo for one (§6.20).
      if (REGISTRY[name].tier !== 1 || REGISTRY[name].confirmation === 'card') continue;
      expect(IMPLEMENTATIONS[name]?.undo, name).toBeTypeOf('function');
    }
  });

  it('gives no card a server undo, and every card an autoRun decision of its own', () => {
    for (const name of TOOL_NAMES) {
      if (REGISTRY[name].confirmation !== 'card') continue;
      expect(IMPLEMENTATIONS[name]?.undo, name).toBeUndefined();
      expect(IMPLEMENTATIONS[name]?.autoRunnable, name).toBeTypeOf('function');
    }
  });

  it('gives no tool above Tier 1 an undo, which would contradict the tier', () => {
    for (const name of TOOL_NAMES) {
      if (REGISTRY[name].tier <= 1) continue;
      expect(IMPLEMENTATIONS[name]?.undo, name).toBeUndefined();
    }
  });

  it('keeps every phone read a Tier 0 read the server never runs (§6.21)', async () => {
    const reads = TOOL_NAMES.filter((name) => REGISTRY[name].phoneRead);
    expect(reads).toEqual(['phone.contacts', 'phone.notifications', 'phone.sms']);
    for (const name of reads) {
      expect(REGISTRY[name].tier, name).toBe(0);
      expect(REGISTRY[name].confirmation, name).toBeUndefined();
      expect(IMPLEMENTATIONS[name]?.undo, name).toBeUndefined();
      await expect(IMPLEMENTATIONS[name]!.execute({}, {} as never), name).rejects.toThrow();
    }
  });

  it('has a schema every implementation can validate against', () => {
    for (const name of TOOL_NAMES) {
      expect(IMPLEMENTATIONS[name]?.inputSchema, name).toBeDefined();
    }
  });
});

describe('tiers', () => {
  it('declares no Tier 4, because there is no Tier 4 code path', () => {
    for (const name of TOOL_NAMES) {
      expect(REGISTRY[name].tier).toBeLessThanOrEqual(3);
    }
  });

  it('gives every tool that touches Google a scope, and every other tool none', () => {
    for (const name of TOOL_NAMES) {
      const touchesGoogle = name.startsWith('calendar.');
      expect(REGISTRY[name].scopes.length > 0, name).toBe(touchesGoogle);
    }
  });

  it('asks for no scope beyond the two in the decisions log', () => {
    // A new scope is a security decision recorded in PLAN §14 first.
    const allowed = new Set([
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.app.created',
    ]);
    for (const name of TOOL_NAMES) {
      for (const scope of REGISTRY[name].scopes) expect(allowed.has(scope), scope).toBe(true);
    }
  });

  it('caps every tool, so nothing can run unbounded', () => {
    for (const name of TOOL_NAMES) {
      expect(REGISTRY[name].rateLimit.perHour, name).toBeGreaterThan(0);
      expect(REGISTRY[name].rateLimit.perDay).toBeGreaterThanOrEqual(
        REGISTRY[name].rateLimit.perHour,
      );
    }
  });
});

describe('what the model is told', () => {
  it('matches the intents the schema accepts', () => {
    expect([...INTENT_NAMES].sort()).toEqual([...TOOL_NAMES, 'unsupported'].sort());
  });

  it('carries no tier, scope or rate limit', () => {
    // The model has no business knowing what is cheap to run or what needs
    // confirming: that would be policy leaking into a prompt.
    const serialized = JSON.stringify(toolCatalog());
    for (const word of ['tier', 'scope', 'rateLimit', 'perHour', 'perDay', 'implementedIn']) {
      expect(serialized).not.toContain(word);
    }
  });

  it('describes every slot with a type', () => {
    for (const entry of toolCatalog()) {
      expect(entry.slotTypes.length, entry.name).toBe(entry.slots.length);
      for (const described of entry.slotTypes) expect(described).toContain(':');
    }
  });
});
