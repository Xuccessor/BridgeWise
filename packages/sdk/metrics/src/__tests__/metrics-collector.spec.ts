import { MetricsCollector } from '../metrics-collector';
import { SdkTelemetryEvent } from '../types';

const makeEvent = (overrides: Partial<SdkTelemetryEvent> = {}): SdkTelemetryEvent => ({
  sdk: 'bridge-core',
  sdkVersion: '0.1.0',
  method: 'getQuote',
  timestamp: Date.now(),
  durationMs: 120,
  success: true,
  ...overrides,
});

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = MetricsCollector.getInstance();
    collector.reset();
  });

  it('records events and returns them via getEvents', () => {
    collector.record(makeEvent());
    collector.record(makeEvent({ method: 'executeTransfer' }));
    expect(collector.size).toBe(2);
    expect(collector.getEvents()).toHaveLength(2);
  });

  it('filters events by sdk', () => {
    collector.record(makeEvent({ sdk: 'bridge-core' }));
    collector.record(makeEvent({ sdk: 'ui' }));
    expect(collector.getEvents({ sdk: 'bridge-core' })).toHaveLength(1);
  });

  it('filters events by method', () => {
    collector.record(makeEvent({ method: 'getQuote' }));
    collector.record(makeEvent({ method: 'executeTransfer' }));
    expect(collector.getEvents({ method: 'getQuote' })).toHaveLength(1);
  });

  it('drops oldest event when buffer is full', () => {
    const small = new (MetricsCollector as any)(3);
    small.record(makeEvent({ method: 'a' }));
    small.record(makeEvent({ method: 'b' }));
    small.record(makeEvent({ method: 'c' }));
    small.record(makeEvent({ method: 'd' }));
    expect(small.size).toBe(3);
    expect(small.getEvents()[0].method).toBe('b');
  });

  it('track records success and returns result', async () => {
    const result = await collector.track('bridge-core', '0.1.0', 'getQuote', async () => 42);
    expect(result).toBe(42);
    expect(collector.size).toBe(1);
    expect(collector.getEvents()[0].success).toBe(true);
  });

  it('track records failure and re-throws', async () => {
    await expect(
      collector.track('bridge-core', '0.1.0', 'getQuote', async () => {
        throw new Error('rpc error');
      }),
    ).rejects.toThrow('rpc error');

    expect(collector.getEvents()[0].success).toBe(false);
    expect(collector.getEvents()[0].error).toBe('rpc error');
  });

  it('reset clears the buffer', () => {
    collector.record(makeEvent());
    collector.reset();
    expect(collector.size).toBe(0);
  });
});
