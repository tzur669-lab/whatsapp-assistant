/** Stable, loggable error codes. Messages never carry user content. */
export const ErrorCode = {
  BadSignature: 'E_BAD_SIGNATURE',
  BodyTooLarge: 'E_BODY_TOO_LARGE',
  MalformedJson: 'E_MALFORMED_JSON',
  NotConfigured: 'E_NOT_CONFIGURED',
  NotAllowed: 'E_NOT_ALLOWED',
  Duplicate: 'E_DUPLICATE',
  Internal: 'E_INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}
