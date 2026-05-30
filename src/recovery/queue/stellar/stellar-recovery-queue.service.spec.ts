import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { StellarRecoveryQueueService } from './stellar-recovery-queue.service';
import { StellarRecoveryQueueItem } from './stellar-recovery-queue.entity';
import { FailedTransferInput } from './stellar-recovery-queue.types';

describe('StellarRecoveryQueueService', () => {
  let service: StellarRecoveryQueueService;
  let repository: Repository<StellarRecoveryQueueItem>;

  const mockItem = {
    id: 'test-id',
    transferHash: 'abc123def456',
    sourceAccount: 'GBJCUKZMTFSLOMNC7P4TS4VJJBTCYL3AEUJ7NWRYWKWNXJXQHX3XGXU',
    destinationAccount: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVXEYN3YLL2CEUKZMF5ZCUZTPx',
    amount: '1000000000',
    assetCode: 'USDC',
    assetIssuer: 'GBBD47UZQ5SDZIinvokez5JYUGM',
    status: 'pending' as const,
    retryCount: 0,
    maxRetries: 5,
    failureReason: 'Network timeout',
    lastError: null,
    recoveryTransactionHash: null,
    recoveredAt: null,
    abandonedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarRecoveryQueueService,
        {
          provide: getRepositoryToken(StellarRecoveryQueueItem),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StellarRecoveryQueueService>(StellarRecoveryQueueService);
    repository = module.get<Repository<StellarRecoveryQueueItem>>(
      getRepositoryToken(StellarRecoveryQueueItem),
    );

    // Mock logger methods on the service instance
    (service as any).logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('enqueueFailedTransfer', () => {
    it('should enqueue a failed transfer', async () => {
      const input: FailedTransferInput = {
        transferHash: 'abc123def456',
        sourceAccount: 'GBJCUKZMTFSLOMNC7P4TS4VJJBTCYL3AEUJ7NWRYWKWNXJXQHX3XGXU',
        destinationAccount: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVXEYN3YLL2CEUKZMF5ZCUZTPX',
        amount: '1000000000',
        assetCode: 'USDC',
        failureReason: 'Network timeout',
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(null);
      jest.spyOn(repository, 'create').mockReturnValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(mockItem);

      const result = await service.enqueueFailedTransfer(input);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { transferHash: input.transferHash },
      });
      expect(repository.create).toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalled();
      expect(result.transferHash).toBe(input.transferHash);
      expect(result.status).toBe('pending');
    });

    it('should throw error if transfer already exists', async () => {
      const input: FailedTransferInput = {
        transferHash: 'abc123def456',
        sourceAccount: 'GBJCUKZMTFSLOMNC7P4TS4VJJBTCYL3AEUJ7NWRYWKWNXJXQHX3XGXU',
        destinationAccount: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVXEYN3YLL2CEUKZMF5ZCUZTPX',
        amount: '1000000000',
        assetCode: 'USDC',
        failureReason: 'Network timeout',
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);

      await expect(service.enqueueFailedTransfer(input)).rejects.toThrow(
        'already in the recovery queue',
      );
    });
  });

  describe('getByTransferHash', () => {
    it('should retrieve a recovery queue item by transfer hash', async () => {
      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);

      const result = await service.getByTransferHash('abc123def456');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { transferHash: 'abc123def456' },
      });
      expect(result).toBeDefined();
      expect(result?.transferHash).toBe('abc123def456');
    });

    it('should return null if transfer not found', async () => {
      jest.spyOn(repository, 'findOne').mockResolvedValue(null);

      const result = await service.getByTransferHash('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getById', () => {
    it('should retrieve a recovery queue item by id', async () => {
      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);

      const result = await service.getById('test-id');

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 'test-id' },
      });
      expect(result).toBeDefined();
      expect(result?.id).toBe('test-id');
    });
  });

  describe('recordRecoveryAttempt', () => {
    it('should mark transfer as recovered on success', async () => {
      const recoveredItem = {
        ...mockItem,
        status: 'recovered' as const,
        recoveryTransactionHash: 'recovery123',
        recoveredAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(recoveredItem);

      const result = await service.recordRecoveryAttempt('test-id', {
        success: true,
        transactionHash: 'recovery123',
      });

      expect(result.status).toBe('recovered');
      expect(result.recoveryTransactionHash).toBe('recovery123');
    });

    it('should increment retry count on failure', async () => {
      const retryingItem = {
        ...mockItem,
        status: 'retrying' as const,
        retryCount: 1,
        lastError: 'Connection refused',
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(retryingItem);

      const result = await service.recordRecoveryAttempt('test-id', {
        success: false,
        error: 'Connection refused',
      });

      expect(result.status).toBe('retrying');
      expect(result.retryCount).toBe(1);
      expect(result.lastError).toBe('Connection refused');
    });

    it('should mark transfer as abandoned when max retries reached', async () => {
      const abandonedItem = {
        ...mockItem,
        status: 'abandoned' as const,
        retryCount: 5,
        maxRetries: 5,
        abandonedAt: new Date(),
        lastError: 'Max retries exceeded',
      };

      const maxRetriesItem = {
        ...mockItem,
        retryCount: 4,
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(maxRetriesItem);
      jest.spyOn(repository, 'save').mockResolvedValue(abandonedItem);

      const result = await service.recordRecoveryAttempt('test-id', {
        success: false,
        error: 'Max retries exceeded',
      });

      expect(result.status).toBe('abandoned');
      expect(result.retryCount).toBe(5);
    });

    it('should throw error if item not found', async () => {
      jest.spyOn(repository, 'findOne').mockResolvedValue(null);

      await expect(
        service.recordRecoveryAttempt('nonexistent', { success: true }),
      ).rejects.toThrow('not found');
    });
  });

  describe('markRecovered', () => {
    it('should mark a transfer as recovered', async () => {
      const recoveredItem = {
        ...mockItem,
        status: 'recovered' as const,
        recoveryTransactionHash: 'recovery123',
        recoveredAt: new Date(),
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(recoveredItem);

      const result = await service.markRecovered('test-id', 'recovery123');

      expect(result.status).toBe('recovered');
      expect(result.recoveryTransactionHash).toBe('recovery123');
    });
  });

  describe('markAbandoned', () => {
    it('should mark a transfer as abandoned', async () => {
      const abandonedItem = {
        ...mockItem,
        status: 'abandoned' as const,
        abandonedAt: new Date(),
        lastError: 'Manual abandonment',
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(abandonedItem);

      const result = await service.markAbandoned('test-id', 'Manual abandonment');

      expect(result.status).toBe('abandoned');
      expect(result.lastError).toBe('Manual abandonment');
    });
  });

  describe('getMetrics', () => {
    it('should return recovery queue metrics', async () => {
      jest.spyOn(repository, 'count').mockResolvedValue(5);

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ avg: 2.5 }),
      };

      jest
        .spyOn(repository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as any);

      const result = await service.getMetrics();

      expect(result.pendingCount).toBe(5);
      expect(result.retryingCount).toBe(5);
      expect(result.recoveredCount).toBe(5);
      expect(result.abandonedCount).toBe(5);
      expect(result.totalCount).toBe(5);
      expect(result.averageRetryAttempts).toBe(2.5);
    });
  });

  describe('getPendingRecoveries', () => {
    it('should retrieve pending and retrying items', async () => {
      const mockQueryBuilder = {
        where: jest
          .fn()
          .mockReturnThis()
          .mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([mockItem]),
      };

      jest
        .spyOn(repository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as any);

      const result = await service.getPendingRecoveries(10);

      expect(result).toHaveLength(1);
      expect(result[0].transferHash).toBe('abc123def456');
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata for a recovery queue item', async () => {
      const updatedItem = {
        ...mockItem,
        metadata: { customField: 'customValue' },
      };

      jest.spyOn(repository, 'findOne').mockResolvedValue(mockItem);
      jest.spyOn(repository, 'save').mockResolvedValue(updatedItem);

      const result = await service.updateMetadata('test-id', {
        customField: 'customValue',
      });

      expect(result.metadata).toEqual({ customField: 'customValue' });
    });
  });

  describe('cleanupAbandoned', () => {
    it('should clean up old abandoned transfers', async () => {
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest
          .fn()
          .mockReturnThis()
          .mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };

      jest
        .spyOn(repository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as any);

      const result = await service.cleanupAbandoned(30);

      expect(result).toBe(3);
    });
  });

  describe('list', () => {
    it('should list recovery queue items with filters', async () => {
      const pendingItem = {
        ...mockItem,
        status: 'pending' as const,
      };

      const mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([pendingItem]),
      };

      jest
        .spyOn(repository, 'createQueryBuilder')
        .mockReturnValue(mockQueryBuilder as any);

      const result = await service.list({
        status: 'pending',
        limit: 50,
        offset: 0,
      });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('pending');
    });
  });
});
