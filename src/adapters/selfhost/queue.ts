/**
 * Redis message queue adapter (self-host deployment).
 *
 * Implements the MessageQueue port over `ioredis` using a reliable-list pattern:
 *   - enqueue: LPUSH the JSON job onto the jobs list.
 *   - subscribe: BRPOPLPUSH from the jobs list into a per-consumer processing
 *     list, run the handler, then LREM the item from the processing list on
 *     success. A crash mid-handler leaves the item on the processing list so it
 *     can be re-queued (at-least-once), making consumers idempotency-friendly.
 *
 * Payloads are plain JSON ValidationJobMessages.
 */

import type { MessageQueue, ValidationJobMessage } from '../../core/ports.js';

/** Minimal structural type for an ioredis client (so `ioredis` isn't a type-time hard dep). */
export interface RedisClient {
  lpush(key: string, value: string): Promise<number>;
  brpoplpush(source: string, destination: string, timeout: number): Promise<string | null>;
  lrem(key: string, count: number, value: string): Promise<number>;
  quit(): Promise<unknown>;
}

export interface RedisQueueConfig {
  client: RedisClient;
  /** List key for pending jobs. Defaults to `agentkitmarket:validation:jobs`. */
  jobsKey?: string;
  /** List key for in-flight jobs. Defaults to `<jobsKey>:processing`. */
  processingKey?: string;
  /** BRPOPLPUSH blocking timeout in seconds. Defaults to 5. */
  blockTimeoutSeconds?: number;
}

export interface RedisQueue extends MessageQueue {
  /** Stops the subscribe loop after the current poll completes. */
  stop(): void;
}

export function createRedisQueue(config: RedisQueueConfig): RedisQueue {
  const client = config.client;
  const jobsKey = config.jobsKey ?? 'agentkitmarket:validation:jobs';
  const processingKey = config.processingKey ?? `${jobsKey}:processing`;
  const blockTimeout = config.blockTimeoutSeconds ?? 5;
  let running = false;

  return {
    async enqueue(payload: ValidationJobMessage): Promise<void> {
      await client.lpush(jobsKey, JSON.stringify(payload));
    },

    async subscribe(handler: (payload: ValidationJobMessage) => Promise<void>): Promise<void> {
      running = true;
      while (running) {
        const raw = await client.brpoplpush(jobsKey, processingKey, blockTimeout);
        if (raw === null) {
          continue;
        }

        let payload: ValidationJobMessage;
        try {
          payload = JSON.parse(raw) as ValidationJobMessage;
        } catch {
          // Non-JSON / poison message: drop it from the processing list so it
          // does not loop forever.
          await client.lrem(processingKey, 1, raw);
          continue;
        }

        try {
          await handler(payload);
          // Success: remove from the processing list (the item is fully handled).
          await client.lrem(processingKey, 1, raw);
        } catch (error) {
          // Leave the item on the processing list for re-queue/inspection.
          console.error('Validation job handler failed; left on processing list', {
            jobId: payload.jobId,
            error,
          });
        }
      }
    },

    stop(): void {
      running = false;
    },
  };
}
