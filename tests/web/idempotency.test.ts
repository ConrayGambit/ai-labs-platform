import { describe, expect, it, vi } from 'vitest';
import {
  createIdempotencyKeyHolder,
  RequestFailedError,
  withIdempotencyKey,
} from '../../src/web/idempotency.js';

/**
 * BLOCKED finding from the 9 August review: the intake key was minted inside the
 * request call, so a retry after a lost response carried a key the server had
 * never seen and created a second project. The assertion that matters in the
 * first test is that both attempts carry the SAME key.
 */
describe('an intake key held across retries', () => {
  const mintSequence = () => {
    let next = 0;
    return () => `key-${(next += 1)}`;
  };

  it('sends the same key when a failed request is retried', async () => {
    const holder = createIdempotencyKeyHolder(mintSequence());
    const send = vi.fn<(headers: Record<string, string>) => Promise<string>>()
      .mockRejectedValueOnce(new RequestFailedError(null, 'Network error'))
      .mockResolvedValueOnce('created');

    await expect(withIdempotencyKey(holder, send)).rejects.toThrow(/network error/i);
    await expect(withIdempotencyKey(holder, send)).resolves.toBe('created');

    expect(send).toHaveBeenCalledTimes(2);
    const [first] = send.mock.calls[0]!;
    const [second] = send.mock.calls[1]!;
    expect(first['Idempotency-Key']).toBe('key-1');
    expect(second['Idempotency-Key']).toBe(first['Idempotency-Key']);
  });

  it('holds the key through a server error, where the outcome is unknown', async () => {
    const holder = createIdempotencyKeyHolder(mintSequence());
    const send = vi.fn<(headers: Record<string, string>) => Promise<string>>()
      .mockRejectedValueOnce(new RequestFailedError(503))
      .mockResolvedValueOnce('created');

    await expect(withIdempotencyKey(holder, send)).rejects.toThrow(/503/);
    await withIdempotencyKey(holder, send);

    expect(send.mock.calls[1]![0]['Idempotency-Key']).toBe(send.mock.calls[0]![0]['Idempotency-Key']);
  });

  it('starts a new key once an attempt succeeds', async () => {
    const holder = createIdempotencyKeyHolder(mintSequence());
    const send = vi.fn<(headers: Record<string, string>) => Promise<string>>()
      .mockResolvedValue('created');

    await withIdempotencyKey(holder, send);
    await withIdempotencyKey(holder, send);

    expect(send.mock.calls[0]![0]['Idempotency-Key']).toBe('key-1');
    expect(send.mock.calls[1]![0]['Idempotency-Key']).toBe('key-2');
  });

  it('releases a key the server has decided on, so an edited retry is not wedged', async () => {
    const holder = createIdempotencyKeyHolder(mintSequence());
    // 409: the key was reused with a different payload. Replaying it can never
    // succeed, so the corrected retry must carry a fresh key.
    const send = vi.fn<(headers: Record<string, string>) => Promise<string>>()
      .mockRejectedValueOnce(new RequestFailedError(409))
      .mockResolvedValueOnce('created');

    await expect(withIdempotencyKey(holder, send)).rejects.toThrow(/409/);
    await withIdempotencyKey(holder, send);

    expect(send.mock.calls[0]![0]['Idempotency-Key']).toBe('key-1');
    expect(send.mock.calls[1]![0]['Idempotency-Key']).toBe('key-2');
  });
});
