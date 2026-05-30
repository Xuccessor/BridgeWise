import { RecoveryStatus } from './stellar-recovery-queue.entity';

export interface FailedTransferInput {
  transferHash: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  failureReason: string;
  metadata?: Record<string, any>;
}

export interface RecoveryQueueItem {
  id: string;
  transferHash: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  status: RecoveryStatus;
  retryCount: number;
  maxRetries: number;
  failureReason: string;
  lastError?: string;
  recoveryTransactionHash?: string;
  recoveredAt?: Date;
  abandonedAt?: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecoveryQueueMetrics {
  pendingCount: number;
  retryingCount: number;
  recoveredCount: number;
  abandonedCount: number;
  totalCount: number;
  averageRetryAttempts: number;
}

export interface RecoveryQueueFilters {
  status?: RecoveryStatus;
  limit?: number;
  offset?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'retryCount';
  sortOrder?: 'ASC' | 'DESC';
}

export interface RecoveryAttemptResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}
