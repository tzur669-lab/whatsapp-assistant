import type { LogFields, Logger } from '../../src/security/redact.js';

export type CapturedLog = { level: string; event: string; fields: LogFields };

export function createFakeLogger(): Logger & { captured: CapturedLog[] } {
  const captured: CapturedLog[] = [];
  const push = (level: string) => (event: string, fields?: LogFields) => {
    captured.push({ level, event, fields: fields ?? {} });
  };
  return {
    captured,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}
