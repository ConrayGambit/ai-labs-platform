import type { PlatformEvent } from '../shared/platform.js';
import type { PlatformRepository } from './platform-repository.js';

export interface PlatformExportWorker {
  start(options?: { includeDeferredFailures?: boolean }): void;
  notify(): void;
  stop(): Promise<void>;
}

interface ExportWorkerOptions {
  repository: PlatformRepository;
  exportEvent: (event: PlatformEvent) => Promise<unknown>;
  retryDelaysMs?: readonly number[];
  drainTimeoutMs?: number;
  logFailure?: (failure: { eventId: string; eventType: string; attempts: number }) => void;
}

const DEFAULT_RETRY_DELAYS = [1_000, 5_000, 30_000, 300_000] as const;

export function createPlatformExportWorker(options: ExportWorkerOptions): PlatformExportWorker {
  const retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS;
  const drainTimeoutMs = options.drainTimeoutMs ?? 2_000;
  let running = false;
  let scheduled = false;
  let rerun = false;
  let includeDeferred = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | null = null;

  const safeLog = (failure: { eventId: string; eventType: string; attempts: number }) => {
    try {
      options.logFailure?.(failure);
    } catch {
      // Operator logging cannot affect durable delivery state.
    }
  };

  const scheduleNext = () => {
    if (!running) return;
    const next = options.repository.getNextExportAttemptAt();
    if (!next) return;
    const delay = Math.max(0, new Date(next).getTime() - Date.now());
    clearTimeout(timer);
    timer = setTimeout(() => worker.notify(), delay);
    timer.unref?.();
  };

  const processReady = async () => {
    let includeDeferredForQuery = includeDeferred;
    includeDeferred = false;
    while (running) {
      const jobs = options.repository.listReadyExports(
        new Date().toISOString(),
        25,
        includeDeferredForQuery,
      );
      includeDeferredForQuery = false;
      if (jobs.length === 0) return;
      for (const job of jobs) {
        if (!running) return;
        try {
          await options.exportEvent(job.event);
          if (!running) return;
          options.repository.markExportCompleted(job.event.id);
        } catch {
          if (!running) return;
          const attempts = job.attempts + 1;
          const delay = retryDelays[Math.min(attempts - 1, retryDelays.length - 1)] ?? 0;
          options.repository.markExportFailed(
            job.event.id,
            attempts,
            new Date(Date.now() + delay).toISOString(),
          );
          safeLog({ eventId: job.event.id, eventType: job.event.type, attempts });
        }
      }
    }
  };

  const run = () => {
    scheduled = false;
    if (!running || active) {
      rerun = running;
      return;
    }
    active = processReady()
      .catch(() => undefined)
      .finally(() => {
        active = null;
        if (rerun) {
          rerun = false;
          worker.notify();
        } else {
          scheduleNext();
        }
      });
  };

  const worker: PlatformExportWorker = {
    start(startOptions) {
      if (running) return;
      running = true;
      includeDeferred = startOptions?.includeDeferredFailures ?? false;
      worker.notify();
    },
    notify() {
      if (!running) return;
      clearTimeout(timer);
      if (active) {
        rerun = true;
        return;
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(run);
    },
    async stop() {
      running = false;
      scheduled = false;
      rerun = false;
      clearTimeout(timer);
      const pending = active;
      if (!pending) return;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs)),
      ]);
    },
  };

  return worker;
}
