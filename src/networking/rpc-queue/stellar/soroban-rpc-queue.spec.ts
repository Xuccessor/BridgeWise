import { SorobanRpcQueue } from './soroban-rpc-queue';

describe('SorobanRpcQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should process simple jobs successfully and record metrics', async () => {
    const queue = new SorobanRpcQueue({
      maxRequestsPerSecond: 10,
      maxRequestsPerMinute: 600,
      maxConcurrency: 2,
    });

    const job = jest.fn().mockResolvedValue('success-val');

    const resultPromise = queue.enqueue(job);
    
    // Process microtasks/timers
    await jest.advanceTimersByTimeAsync(0);

    const result = await resultPromise;
    expect(result).toBe('success-val');
    expect(job).toHaveBeenCalledTimes(1);

    const metrics = queue.getMetrics();
    expect(metrics.completedCount).toBe(1);
    expect(metrics.pendingCount).toBe(0);
    expect(metrics.activeCount).toBe(0);
  });

  it('should process jobs in order of priority (HIGH -> MEDIUM -> LOW)', async () => {
    const queue = new SorobanRpcQueue({
      maxRequestsPerSecond: 10,
      maxRequestsPerMinute: 600,
      maxConcurrency: 1, // process one at a time so we can check order
    });

    const runOrder: string[] = [];

    // Enqueue some tasks to fill concurrency slot
    const blockingJob = () => new Promise<void>((resolve) => {
      setTimeout(() => {
        runOrder.push('blocking');
        resolve();
      }, 100);
    });

    const lowJob = () => {
      runOrder.push('low');
      return Promise.resolve();
    };

    const medJob = () => {
      runOrder.push('medium');
      return Promise.resolve();
    };

    const highJob = () => {
      runOrder.push('high');
      return Promise.resolve();
    };

    const pBlocking = queue.enqueue(blockingJob, 'MEDIUM');
    const pLow = queue.enqueue(lowJob, 'LOW');
    const pMed = queue.enqueue(medJob, 'MEDIUM');
    const pHigh = queue.enqueue(highJob, 'HIGH');

    // Run blocking job
    await jest.advanceTimersByTimeAsync(100);
    await pBlocking;

    // Run remaining jobs
    await jest.advanceTimersByTimeAsync(100);
    await Promise.all([pLow, pMed, pHigh]);

    // Order should be: blocking, high, medium, low
    expect(runOrder).toEqual(['blocking', 'high', 'medium', 'low']);
  });

  it('should enforce concurrency limit', async () => {
    const queue = new SorobanRpcQueue({
      maxRequestsPerSecond: 10,
      maxRequestsPerMinute: 600,
      maxConcurrency: 2,
    });

    let runningCount = 0;
    let maxObservedRunning = 0;

    const job = () => new Promise<void>((resolve) => {
      runningCount++;
      if (runningCount > maxObservedRunning) {
        maxObservedRunning = runningCount;
      }
      setTimeout(() => {
        runningCount--;
        resolve();
      }, 50);
    });

    const promises = [
      queue.enqueue(job),
      queue.enqueue(job),
      queue.enqueue(job),
      queue.enqueue(job),
    ];

    await jest.advanceTimersByTimeAsync(200);
    await Promise.all(promises);

    expect(maxObservedRunning).toBeLessThanOrEqual(2);
  });

  it('should throttle requests when rates are exceeded', async () => {
    // 2 requests per second maximum
    const queue = new SorobanRpcQueue({
      maxRequestsPerSecond: 2,
      maxRequestsPerMinute: 120,
      maxConcurrency: 5,
    });

    const job = jest.fn().mockResolvedValue('ok');

    // Enqueue 3 requests immediately
    const p1 = queue.enqueue(job);
    const p2 = queue.enqueue(job);
    const p3 = queue.enqueue(job);

    // Run immediate tasks (should consume 2 tokens)
    await jest.advanceTimersByTimeAsync(0);

    const metricsBefore = queue.getMetrics();
    expect(metricsBefore.throttledCount).toBe(1); // 3rd request was throttled
    expect(metricsBefore.pendingCount).toBe(1);

    // Let the second bucket refill (requires 500ms for 1 token if rate is 2/sec)
    await jest.advanceTimersByTimeAsync(500);

    await Promise.all([p1, p2, p3]);

    expect(job).toHaveBeenCalledTimes(3);
    expect(queue.getMetrics().pendingCount).toBe(0);
  });

  it('should enforce request timeouts', async () => {
    const queue = new SorobanRpcQueue({
      timeoutMs: 50,
      maxRetries: 0,
    });

    // A job that hangs forever
    const slowJob = () => new Promise<string>(() => {});

    const promise = queue.enqueue(slowJob);
    const testPromise = expect(promise).rejects.toThrow('Soroban RPC request timed out after 50ms');

    await jest.advanceTimersByTimeAsync(100);

    await testPromise;
  });

  it('should retry retryable failures with exponential backoff', async () => {
    const queue = new SorobanRpcQueue({
      maxRetries: 2,
      baseDelayMs: 100,
      maxRequestsPerSecond: 100,
      maxRequestsPerMinute: 6000,
    });

    let calls = 0;
    const failingJob = jest.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) {
        return Promise.reject(new Error('Rate limit exceeded (HTTP 429)'));
      }
      return Promise.resolve('success-value');
    });

    const promise = queue.enqueue(failingJob);

    // First attempt fails immediately, schedules retry
    await jest.advanceTimersByTimeAsync(0);
    
    // Backoff delay is random between 0 and 100ms for 1st retry.
    // Advance time by 100ms to guarantee retry fires
    await jest.advanceTimersByTimeAsync(100);
    
    // Second attempt fails, schedules 2nd retry (backoff between 0 and 200ms)
    await jest.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('success-value');
    expect(failingJob).toHaveBeenCalledTimes(3);
    
    const metrics = queue.getMetrics();
    expect(metrics.retriedCount).toBe(2);
    expect(metrics.completedCount).toBe(1);
  });

  it('should reject when retry limit is exhausted', async () => {
    const queue = new SorobanRpcQueue({
      maxRetries: 2,
      baseDelayMs: 50,
      maxRequestsPerSecond: 100,
    });

    const failingJob = jest.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    const promise = queue.enqueue(failingJob);
    const testPromise = expect(promise).rejects.toThrow('503 Service Unavailable');

    await jest.advanceTimersByTimeAsync(500);

    await testPromise;
    expect(failingJob).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(queue.getMetrics().failedCount).toBe(1);
  });

  it('should not retry non-retryable failures', async () => {
    const queue = new SorobanRpcQueue({
      maxRetries: 3,
    });

    const failingJob = jest.fn().mockRejectedValue(new Error('Invalid signature'));

    const promise = queue.enqueue(failingJob);
    const testPromise = expect(promise).rejects.toThrow('Invalid signature');

    await jest.advanceTimersByTimeAsync(0);

    await testPromise;
    expect(failingJob).toHaveBeenCalledTimes(1); // Should fail immediately without retrying
    expect(queue.getMetrics().failedCount).toBe(1);
    expect(queue.getMetrics().retriedCount).toBe(0);
  });

  it('should support dynamic limit updates', async () => {
    const queue = new SorobanRpcQueue({
      maxRequestsPerSecond: 1,
      maxRequestsPerMinute: 60,
    });

    queue.updateLimits(10, 600);

    const job = jest.fn().mockResolvedValue('ok');

    // Enqueue 5 jobs
    const promises = Array(5).fill(null).map(() => queue.enqueue(job));

    await jest.advanceTimersByTimeAsync(0);
    await Promise.all(promises);

    expect(job).toHaveBeenCalledTimes(5);
    expect(queue.getMetrics().throttledCount).toBe(0); // None throttled because capacity is 10 now
  });

  it('should allow clearing the queue', async () => {
    const queue = new SorobanRpcQueue({
      maxConcurrency: 1,
    });

    // Enqueue a job to block the queue
    const block = () => new Promise<void>(() => {});
    queue.enqueue(block);

    const job = jest.fn().mockResolvedValue('ok');
    const p1 = queue.enqueue(job);
    const p2 = queue.enqueue(job);

    const testP1 = expect(p1).rejects.toThrow('Queue cleared. Request cancelled.');
    const testP2 = expect(p2).rejects.toThrow('Queue cleared. Request cancelled.');

    queue.clear();

    await Promise.all([testP1, testP2]);

    const metrics = queue.getMetrics();
    expect(metrics.pendingCount).toBe(0);
  });
});
