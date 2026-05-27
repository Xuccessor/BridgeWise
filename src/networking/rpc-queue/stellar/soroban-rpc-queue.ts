import { SorobanRpcThrottler } from './soroban-rpc-throttler';
import { QueueJob, QueueMetrics, QueuePriority, SorobanRpcQueueConfig } from './soroban-rpc-queue.types';

export class SorobanRpcQueue {
  private readonly config: Required<SorobanRpcQueueConfig>;
  private readonly throttler: SorobanRpcThrottler;

  private readonly highQueue: QueueJob[] = [];
  private readonly mediumQueue: QueueJob[] = [];
  private readonly lowQueue: QueueJob[] = [];

  private activeCount = 0;
  private processing = false;
  private processTimeout: NodeJS.Timeout | null = null;
  private nextProcessTime = 0;

  private totalWaitTimeMs = 0;
  private readonly metrics = {
    completedCount: 0,
    failedCount: 0,
    retriedCount: 0,
    throttledCount: 0,
  };

  constructor(config: SorobanRpcQueueConfig = {}) {
    this.config = {
      maxRequestsPerSecond: config.maxRequestsPerSecond ?? 5,
      maxRequestsPerMinute: config.maxRequestsPerMinute ?? 100,
      maxConcurrency: config.maxConcurrency ?? 3,
      maxRetries: config.maxRetries ?? 3,
      baseDelayMs: config.baseDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30000,
      timeoutMs: config.timeoutMs ?? 15000,
    };

    this.throttler = new SorobanRpcThrottler(
      this.config.maxRequestsPerSecond,
      this.config.maxRequestsPerMinute
    );
  }

  /**
   * Enqueue an outbound Soroban RPC request
   */
  enqueue<T>(
    fn: () => Promise<T>,
    priority: QueuePriority = 'MEDIUM',
    weight: number = 1
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueueJob<T> = {
        id: this.generateId(),
        fn,
        priority,
        weight,
        addedAt: new Date(),
        retries: 0,
        resolve,
        reject,
      };

      this.enqueueJobInternal(job);
      this.process();
    });
  }

  /**
   * Update limits dynamically
   */
  updateLimits(maxRequestsPerSecond: number, maxRequestsPerMinute: number): void {
    this.config.maxRequestsPerSecond = maxRequestsPerSecond;
    this.config.maxRequestsPerMinute = maxRequestsPerMinute;
    this.throttler.updateLimits(maxRequestsPerSecond, maxRequestsPerMinute);

    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
      this.processTimeout = null;
      this.nextProcessTime = 0;
    }
    this.process();
  }

  /**
   * Get current queue metrics
   */
  getMetrics(): QueueMetrics {
    const pendingCount = this.highQueue.length + this.mediumQueue.length + this.lowQueue.length;
    const completedTotal = this.metrics.completedCount;
    const avgWaitTime = completedTotal > 0 ? this.totalWaitTimeMs / completedTotal : 0;

    return {
      pendingCount,
      activeCount: this.activeCount,
      completedCount: this.metrics.completedCount,
      failedCount: this.metrics.failedCount,
      retriedCount: this.metrics.retriedCount,
      throttledCount: this.metrics.throttledCount,
      averageWaitTimeMs: avgWaitTime,
    };
  }

  /**
   * Clear all pending requests from the queue
   */
  clear(): void {
    const cancelError = new Error('Queue cleared. Request cancelled.');
    
    const clearQueue = (queue: QueueJob[]) => {
      while (queue.length > 0) {
        const job = queue.shift();
        job?.reject(cancelError);
      }
    };

    clearQueue(this.highQueue);
    clearQueue(this.mediumQueue);
    clearQueue(this.lowQueue);

    if (this.processTimeout) {
      clearTimeout(this.processTimeout);
      this.processTimeout = null;
      this.nextProcessTime = 0;
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 11) + '-' + Date.now();
  }

  private enqueueJobInternal(job: QueueJob): void {
    if (job.priority === 'HIGH') {
      this.highQueue.push(job);
    } else if (job.priority === 'MEDIUM') {
      this.mediumQueue.push(job);
    } else {
      this.lowQueue.push(job);
    }
  }

  private requeueJobAtFront(job: QueueJob): void {
    if (job.priority === 'HIGH') {
      this.highQueue.unshift(job);
    } else if (job.priority === 'MEDIUM') {
      this.mediumQueue.unshift(job);
    } else {
      this.lowQueue.unshift(job);
    }
  }

  private getNextJob(): QueueJob | null {
    if (this.highQueue.length > 0) return this.highQueue.shift()!;
    if (this.mediumQueue.length > 0) return this.mediumQueue.shift()!;
    if (this.lowQueue.length > 0) return this.lowQueue.shift()!;
    return null;
  }

  private scheduleNextProcess(waitMs: number): void {
    const targetTime = Date.now() + waitMs;
    if (!this.processTimeout || targetTime < this.nextProcessTime) {
      if (this.processTimeout) {
        clearTimeout(this.processTimeout);
      }
      this.nextProcessTime = targetTime;
      this.processTimeout = setTimeout(() => {
        this.processTimeout = null;
        this.nextProcessTime = 0;
        this.process();
      }, waitMs);
    }
  }

  private process(): void {
    if (this.processing) return;
    if (this.processTimeout && this.nextProcessTime > Date.now()) {
      return;
    }
    this.processing = true;

    try {
      while (this.activeCount < this.config.maxConcurrency) {
        const job = this.getNextJob();
        if (!job) break;

        const waitMs = this.throttler.consume(job.weight);
        if (waitMs > 0) {
          // Throttled! Put back at the front of the queue
          this.requeueJobAtFront(job);
          this.metrics.throttledCount++;
          
          this.scheduleNextProcess(waitMs);
          break;
        }

        // Execute job
        this.executeJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private executeJob(job: QueueJob): void {
    this.activeCount++;
    const startTime = Date.now();

    let timeoutId: NodeJS.Timeout | null = null;
    let aborted = false;

    if (this.config.timeoutMs && this.config.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        aborted = true;
        this.activeCount--;
        this.handleJobFailure(job, new Error(`Soroban RPC request timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
    }

    Promise.resolve()
      .then(() => job.fn())
      .then((result) => {
        if (aborted) return;
        if (timeoutId) clearTimeout(timeoutId);

        this.activeCount--;
        this.metrics.completedCount++;
        this.totalWaitTimeMs += Date.now() - startTime;
        
        job.resolve(result);
        this.process();
      })
      .catch((error) => {
        if (aborted) return;
        if (timeoutId) clearTimeout(timeoutId);

        this.activeCount--;
        this.handleJobFailure(job, error);
      });
  }

  private handleJobFailure(job: QueueJob, error: any): void {
    if (job.retries < this.config.maxRetries && this.isRetryableError(error)) {
      job.retries++;
      this.metrics.retriedCount++;

      const delay = this.getBackoffDelay(job.retries);
      setTimeout(() => {
        this.enqueueJobInternal(job);
        this.process();
      }, delay);
    } else {
      this.metrics.failedCount++;
      job.reject(error);
      this.process();
    }
  }

  private getBackoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.config.baseDelayMs * Math.pow(2, attempt - 1),
      this.config.maxDelayMs
    );
    // Full Jitter
    return Math.floor(Math.random() * exponential);
  }

  private isRetryableError(error: any): boolean {
    const msg = String(error?.message || error).toLowerCase();
    
    if (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('deadline') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('bad gateway') ||
      msg.includes('service unavailable') ||
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('conn')
    ) {
      return true;
    }
    return false;
  }
}
