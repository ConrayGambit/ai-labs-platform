/**
 * One idempotency key per attempt at an operation, held across retries.
 *
 * A key minted inside the request call defeats replay entirely: every retry
 * carries a key the server has never seen, so a lost response produces a second
 * project instead of returning the first. The key has to outlive the failed
 * request and be released only once the outcome is known.
 */
export interface IdempotencyKeyHolder {
  /** The key for the attempt in progress, minting one on first use. */
  current(): string;
  /** Discard the held key so the next attempt is a new operation. */
  release(): void;
}

export function createIdempotencyKeyHolder(mint: () => string): IdempotencyKeyHolder {
  let key: string | null = null;
  return {
    current: () => (key ??= mint()),
    release: () => {
      key = null;
    },
  };
}

/** A request failure that carries the HTTP status, when there was one. */
export class RequestFailedError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message?: string) {
    super(message ?? (status === null ? 'Request failed' : `Request failed (${status})`));
    this.name = 'RequestFailedError';
    this.status = status;
  }
}

function statusOf(reason: unknown): number | null {
  return reason instanceof RequestFailedError ? reason.status : null;
}

/**
 * Send an operation under a held key.
 *
 * The rule is: keep the key only while the outcome is unknown. A network error
 * or a 5xx may or may not have committed, and replaying is exactly what the key
 * exists for. A 4xx is a decided answer — the request was rejected, so the key
 * is spent and holding it would wedge the form against an edited retry.
 */
export async function withIdempotencyKey<T>(
  holder: IdempotencyKeyHolder,
  send: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  try {
    const result = await send({ 'Idempotency-Key': holder.current() });
    holder.release();
    return result;
  } catch (reason) {
    const status = statusOf(reason);
    if (status !== null && status >= 400 && status < 500) holder.release();
    throw reason;
  }
}
