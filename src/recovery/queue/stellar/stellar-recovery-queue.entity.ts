import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type RecoveryStatus = 'pending' | 'retrying' | 'recovered' | 'abandoned';

/**
 * Stores failed Stellar transfers for recovery workflows.
 * Enables automatic and manual retry mechanisms for stuck transfers.
 */
@Entity('stellar_recovery_queue')
@Index(['status', 'createdAt'])
@Index(['transferHash'])
export class StellarRecoveryQueueItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Transaction hash of the failed transfer on Stellar network
   */
  @Column({ type: 'varchar', length: 64, unique: true })
  transferHash: string;

  /**
   * Source account address
   */
  @Column({ type: 'varchar', length: 56 })
  sourceAccount: string;

  /**
   * Destination account address
   */
  @Column({ type: 'varchar', length: 56 })
  destinationAccount: string;

  /**
   * Amount transferred (in stroops)
   */
  @Column({ type: 'decimal', precision: 78, scale: 0 })
  amount: string;

  /**
   * Asset code being transferred
   */
  @Column({ type: 'varchar', length: 12 })
  assetCode: string;

  /**
   * Asset issuer address
   */
  @Column({ type: 'varchar', length: 56, nullable: true })
  assetIssuer: string;

  /**
   * Current recovery status
   */
  @Column({ type: 'enum', enum: ['pending', 'retrying', 'recovered', 'abandoned'], default: 'pending' })
  status: RecoveryStatus;

  /**
   * Number of recovery attempts
   */
  @Column({ type: 'int', default: 0 })
  retryCount: number;

  /**
   * Maximum number of retry attempts allowed
   */
  @Column({ type: 'int', default: 5 })
  maxRetries: number;

  /**
   * Reason for initial failure
   */
  @Column({ type: 'text', nullable: true })
  failureReason: string;

  /**
   * Last error encountered during recovery attempts
   */
  @Column({ type: 'text', nullable: true })
  lastError: string;

  /**
   * Transaction hash from successful recovery attempt (if recovered)
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  recoveryTransactionHash: string;

  /**
   * Timestamp when recovery was completed
   */
  @Column({ type: 'timestamp', nullable: true })
  recoveredAt: Date;

  /**
   * Timestamp when recovery was abandoned
   */
  @Column({ type: 'timestamp', nullable: true })
  abandonedAt: Date;

  /**
   * Additional metadata for recovery operations
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
