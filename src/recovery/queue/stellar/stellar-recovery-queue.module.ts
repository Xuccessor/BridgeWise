import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StellarRecoveryQueueItem } from './stellar-recovery-queue.entity';
import { StellarRecoveryQueueService } from './stellar-recovery-queue.service';

/**
 * Stellar Recovery Queue Module
 *
 * Provides infrastructure for storing and managing failed Stellar transfers
 * for recovery workflows. Enables automatic and manual retry mechanisms.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StellarRecoveryQueueItem])],
  providers: [StellarRecoveryQueueService],
  exports: [StellarRecoveryQueueService],
})
export class StellarRecoveryQueueModule {}
