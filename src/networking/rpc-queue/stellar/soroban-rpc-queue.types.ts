export type QueuePriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SorobanRpcQueueConfig {
  maxRequestsPerSecond?: number;
  maxRequestsPerMinute?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export interface QueueJob<T = any> {
  id: string;
  fn: () => Promise<T>;
  priority: QueuePriority;
  weight: number;
  addedAt: Date;
  retries: number;
  resolve: (value: T) => void;
  reject: (reason: any) => void;
}

export interface QueueMetrics {
  pendingCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  retriedCount: number;
  throttledCount: number;
  averageWaitTimeMs: number;
}
