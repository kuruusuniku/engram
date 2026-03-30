/**
 * EmbeddingQueue - Batch processing and queueing for embedding generation
 *
 * Optimizes embedding generation by:
 * - Batching multiple requests into single API calls
 * - Processing asynchronously with configurable concurrency
 * - Providing queue status and drain capability
 */

import type { EmbeddingClient } from "./embedding.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { createLogger } from "./logger.js";

const log = createLogger("embedding-queue");

export interface EmbeddingQueueConfig {
  /** Maximum batch size for API calls (default: 20) */
  batchSize?: number;
  /** Delay in ms before flushing a partial batch (default: 500) */
  flushDelayMs?: number;
  /** Maximum queue size before rejecting (default: 1000) */
  maxQueueSize?: number;
}

export interface EmbeddingJob {
  noteId: string;
  text: string;
  resolve: (success: boolean) => void;
}

export interface QueueStatus {
  pending: number;
  processing: boolean;
  totalProcessed: number;
  totalFailed: number;
}

export class EmbeddingQueue {
  private queue: EmbeddingJob[] = [];
  private processing = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private totalProcessed = 0;
  private totalFailed = 0;
  private batchSize: number;
  private flushDelayMs: number;
  private maxQueueSize: number;

  constructor(
    private embeddingClient: EmbeddingClient,
    private adapter: StorageAdapter,
    config?: EmbeddingQueueConfig
  ) {
    this.batchSize = config?.batchSize ?? 20;
    this.flushDelayMs = config?.flushDelayMs ?? 500;
    this.maxQueueSize = config?.maxQueueSize ?? 1000;
  }

  /**
   * Enqueue a note for embedding generation.
   * Returns a promise that resolves when the embedding is saved.
   */
  async enqueue(noteId: string, text: string): Promise<boolean> {
    if (!this.embeddingClient.available) {
      return false;
    }

    if (this.queue.length >= this.maxQueueSize) {
      log.warn("Queue full, rejecting embedding request", { noteId, queueSize: this.queue.length });
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.queue.push({ noteId, text, resolve });
      log.debug("Enqueued embedding job", { noteId, queueSize: this.queue.length });

      // If batch is full, flush immediately
      if (this.queue.length >= this.batchSize) {
        this.flush();
      } else {
        // Schedule a delayed flush for partial batches
        this.scheduleFlush();
      }
    });
  }

  /**
   * Get current queue status
   */
  getStatus(): QueueStatus {
    return {
      pending: this.queue.length,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
    };
  }

  /**
   * Drain the queue: process all pending items and wait for completion
   */
  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.queue.length > 0 || this.processing) {
      if (this.queue.length > 0 && !this.processing) {
        await this.processBatch();
      } else if (this.processing) {
        // Wait a tick for current processing to finish
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  /**
   * Schedule a delayed flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);

    // Don't prevent process exit
    if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush: start processing if not already
   */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.processing && this.queue.length > 0) {
      this.processBatch().catch((error) => {
        log.error("Batch processing failed", { error: String(error) });
      });
    }
  }

  /**
   * Process one batch from the queue
   */
  private async processBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const batch = this.queue.splice(0, this.batchSize);

    log.info("Processing embedding batch", { batchSize: batch.length });

    try {
      const texts = batch.map((job) => job.text);
      const embeddings = await this.embeddingClient.embedBatch(texts);

      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        const embedding = embeddings[i];

        if (embedding && this.adapter.saveEmbedding) {
          try {
            await this.adapter.saveEmbedding(job.noteId, embedding);
            this.totalProcessed++;
            job.resolve(true);
          } catch (error) {
            log.error("Failed to save embedding", {
              noteId: job.noteId,
              error: String(error),
            });
            this.totalFailed++;
            job.resolve(false);
          }
        } else {
          this.totalFailed++;
          job.resolve(false);
        }
      }
    } catch (error) {
      log.error("Batch embedding generation failed", { error: String(error) });
      // Resolve all jobs as failed
      for (const job of batch) {
        this.totalFailed++;
        job.resolve(false);
      }
    } finally {
      this.processing = false;

      // Process next batch if queue has items
      if (this.queue.length > 0) {
        this.flush();
      }
    }
  }

  /**
   * Cleanup: drain queue and clear timers
   */
  async cleanup(): Promise<void> {
    await this.drain();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
