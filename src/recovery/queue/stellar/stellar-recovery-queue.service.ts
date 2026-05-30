import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StellarRecoveryQueueItem, RecoveryStatus } from './stellar-recovery-queue.entity';
import {
  FailedTransferInput,
  RecoveryQueueItem,
  RecoveryQueueMetrics,
  RecoveryQueueFilters,
  RecoveryAttemptResult,
} from './stellar-recovery-queue.types';

/**
 * Service for managing Stellar transfer recovery queue.
 *
 * Responsibilities:
 * - Store failed transfers for recovery workflows
 * - Track retry attempts and recovery status
 * - Provide metrics and filtering capabilities
 * - Support manual and automated recovery operations
 */
@Injectable()
export class StellarRecoveryQueueService {
  private readonly logger = new Logger(StellarRecoveryQueueService.name);

  constructor(
    @InjectRepository(StellarRecoveryQueueItem)
    private readonly repository: Repository<StellarRecoveryQueueItem>,
  ) {}

  /**
   * Enqueue a failed transfer for recovery
   *
   * @param input Failed transfer details
   * @returns The created recovery queue item
   * @throws Error if transfer already exists in queue
   */
  async enqueueFailedTransfer(input: FailedTransferInput): Promise<RecoveryQueueItem> {
    this.logger.debug(
      `Enqueueing failed transfer: ${input.transferHash} from ${input.sourceAccount}`,
    );

    // Check if transfer is already in queue
    const existing = await this.repository.findOne({
      where: { transferHash: input.transferHash },
    });

    if (existing) {
      this.logger.warn(
        `Transfer ${input.transferHash} already in recovery queue`,
      );
      throw new Error(
        `Transfer ${input.transferHash} is already in the recovery queue`,
      );
    }

    const item = this.repository.create({
      transferHash: input.transferHash,
      sourceAccount: input.sourceAccount,
      destinationAccount: input.destinationAccount,
      amount: input.amount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      status: 'pending',
      retryCount: 0,
      maxRetries: 5,
      failureReason: input.failureReason,
      metadata: input.metadata || {},
    });

    const saved = await this.repository.save(item);
    this.logger.info(
      `Failed transfer ${input.transferHash} enqueued with ID ${saved.id}`,
    );

    return this.mapToRecoveryQueueItem(saved);
  }

  /**
   * Get a recovery queue item by transfer hash
   *
   * @param transferHash The Stellar transaction hash
   * @returns The recovery queue item or null if not found
   */
  async getByTransferHash(transferHash: string): Promise<RecoveryQueueItem | null> {
    const item = await this.repository.findOne({
      where: { transferHash },
    });
    return item ? this.mapToRecoveryQueueItem(item) : null;
  }

  /**
   * Get a recovery queue item by ID
   *
   * @param id The recovery queue item ID
   * @returns The recovery queue item or null if not found
   */
  async getById(id: string): Promise<RecoveryQueueItem | null> {
    const item = await this.repository.findOne({
      where: { id },
    });
    return item ? this.mapToRecoveryQueueItem(item) : null;
  }

  /**
   * List recovery queue items with optional filtering
   *
   * @param filters Optional filter criteria
   * @returns Array of recovery queue items
   */
  async list(filters: RecoveryQueueFilters = {}): Promise<RecoveryQueueItem[]> {
    const query = this.repository.createQueryBuilder('item');

    if (filters.status) {
      query.where('item.status = :status', { status: filters.status });
    }

    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    query.orderBy(`item.${sortBy}`, sortOrder);

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query.take(limit).skip(offset);

    const items = await query.getMany();
    return items.map((item) => this.mapToRecoveryQueueItem(item));
  }

  /**
   * Record a recovery attempt for a transfer
   *
   * @param id Recovery queue item ID
   * @param result Result of the recovery attempt
   * @returns The updated recovery queue item
   */
  async recordRecoveryAttempt(
    id: string,
    result: RecoveryAttemptResult,
  ): Promise<RecoveryQueueItem> {
    const item = await this.repository.findOne({ where: { id } });

    if (!item) {
      throw new Error(`Recovery queue item ${id} not found`);
    }

    if (result.success) {
      item.status = 'recovered';
      item.recoveryTransactionHash = result.transactionHash;
      item.recoveredAt = new Date();
      this.logger.info(
        `Transfer ${item.transferHash} successfully recovered with tx ${result.transactionHash}`,
      );
    } else {
      item.retryCount += 1;
      item.lastError = result.error;

      if (item.retryCount >= item.maxRetries) {
        item.status = 'abandoned';
        item.abandonedAt = new Date();
        this.logger.warn(
          `Transfer ${item.transferHash} abandoned after ${item.retryCount} attempts`,
        );
      } else {
        item.status = 'retrying';
        this.logger.warn(
          `Transfer ${item.transferHash} retry attempt ${item.retryCount}/${item.maxRetries}`,
        );
      }
    }

    const updated = await this.repository.save(item);
    return this.mapToRecoveryQueueItem(updated);
  }

  /**
   * Mark a transfer as manually recovered
   *
   * @param id Recovery queue item ID
   * @param transactionHash The successful recovery transaction hash
   * @returns The updated recovery queue item
   */
  async markRecovered(
    id: string,
    transactionHash: string,
  ): Promise<RecoveryQueueItem> {
    const item = await this.repository.findOne({ where: { id } });

    if (!item) {
      throw new Error(`Recovery queue item ${id} not found`);
    }

    item.status = 'recovered';
    item.recoveryTransactionHash = transactionHash;
    item.recoveredAt = new Date();

    const updated = await this.repository.save(item);
    this.logger.info(
      `Transfer ${item.transferHash} marked as recovered (tx: ${transactionHash})`,
    );
    return this.mapToRecoveryQueueItem(updated);
  }

  /**
   * Mark a transfer as abandoned
   *
   * @param id Recovery queue item ID
   * @param reason Optional reason for abandonment
   * @returns The updated recovery queue item
   */
  async markAbandoned(id: string, reason?: string): Promise<RecoveryQueueItem> {
    const item = await this.repository.findOne({ where: { id } });

    if (!item) {
      throw new Error(`Recovery queue item ${id} not found`);
    }

    item.status = 'abandoned';
    item.abandonedAt = new Date();
    if (reason) {
      item.lastError = reason;
    }

    const updated = await this.repository.save(item);
    this.logger.warn(
      `Transfer ${item.transferHash} manually abandoned: ${reason || 'no reason provided'}`,
    );
    return this.mapToRecoveryQueueItem(updated);
  }

  /**
   * Get recovery queue metrics
   *
   * @returns Queue metrics
   */
  async getMetrics(): Promise<RecoveryQueueMetrics> {
    const [
      pendingCount,
      retryingCount,
      recoveredCount,
      abandonedCount,
      totalCount,
    ] = await Promise.all([
      this.repository.count({ where: { status: 'pending' } }),
      this.repository.count({ where: { status: 'retrying' } }),
      this.repository.count({ where: { status: 'recovered' } }),
      this.repository.count({ where: { status: 'abandoned' } }),
      this.repository.count(),
    ]);

    // Calculate average retry attempts for non-pending items
    const result = await this.repository
      .createQueryBuilder('item')
      .select('AVG(item.retryCount)', 'avg')
      .where('item.status != :status', { status: 'pending' })
      .getRawOne<{ avg: number | null }>();

    const averageRetryAttempts = result?.avg ? Math.round(result.avg * 100) / 100 : 0;

    return {
      pendingCount,
      retryingCount,
      recoveredCount,
      abandonedCount,
      totalCount,
      averageRetryAttempts,
    };
  }

  /**
   * Get pending recoveries ready for retry
   *
   * @param limit Maximum number of items to return
   * @returns Array of pending recovery queue items
   */
  async getPendingRecoveries(limit: number = 10): Promise<RecoveryQueueItem[]> {
    const items = await this.repository
      .createQueryBuilder('item')
      .where('item.status IN (:...statuses)', { statuses: ['pending', 'retrying'] })
      .where('item.retryCount < item.maxRetries')
      .orderBy('item.createdAt', 'ASC')
      .take(limit)
      .getMany();

    return items.map((item) => this.mapToRecoveryQueueItem(item));
  }

  /**
   * Clean up old abandoned transfers (retention policy)
   *
   * @param olderThanDays Remove abandoned transfers older than this many days
   * @returns Number of cleaned up items
   */
  async cleanupAbandoned(olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .where('status = :status', { status: 'abandoned' })
      .where('abandonedAt < :cutoffDate', { cutoffDate })
      .execute();

    const deletedCount = result.affected || 0;
    this.logger.info(
      `Cleaned up ${deletedCount} abandoned transfers older than ${olderThanDays} days`,
    );
    return deletedCount;
  }

  /**
   * Update metadata for a recovery queue item
   *
   * @param id Recovery queue item ID
   * @param metadata New metadata to merge
   * @returns The updated recovery queue item
   */
  async updateMetadata(
    id: string,
    metadata: Record<string, any>,
  ): Promise<RecoveryQueueItem> {
    const item = await this.repository.findOne({ where: { id } });

    if (!item) {
      throw new Error(`Recovery queue item ${id} not found`);
    }

    item.metadata = {
      ...item.metadata,
      ...metadata,
    };

    const updated = await this.repository.save(item);
    return this.mapToRecoveryQueueItem(updated);
  }

  /**
   * Map entity to DTO
   */
  private mapToRecoveryQueueItem(entity: StellarRecoveryQueueItem): RecoveryQueueItem {
    return {
      id: entity.id,
      transferHash: entity.transferHash,
      sourceAccount: entity.sourceAccount,
      destinationAccount: entity.destinationAccount,
      amount: entity.amount,
      assetCode: entity.assetCode,
      assetIssuer: entity.assetIssuer,
      status: entity.status,
      retryCount: entity.retryCount,
      maxRetries: entity.maxRetries,
      failureReason: entity.failureReason,
      lastError: entity.lastError,
      recoveryTransactionHash: entity.recoveryTransactionHash,
      recoveredAt: entity.recoveredAt,
      abandonedAt: entity.abandonedAt,
      metadata: entity.metadata,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
