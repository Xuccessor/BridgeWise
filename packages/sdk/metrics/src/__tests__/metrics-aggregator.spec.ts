import { MetricsAggregator } from '../metrics-aggregator';
import { SdkTelemetryEvent } from '../types';

const makeEvent = (overrides: Partial<SdkTelemetryEvent> = {}): SdkTelemetryEvent => ({
  sdk: 'bridge-core',
  sdkVersion: '0.1.0',
  method: 'getQuote',
  timestamp: Date.now(),
  durationMs: 100,
  success: true,
  ...overrides,
});

describe('MetricsAggregator', () => {
  const agg = new MetricsAggregator();

  it('returns empty arrays for no events', () => {
    expect(agg.aggregateBySdk([])).toEqual([]);
    expect(agg.aggregateByMethod([])).toEqual([]);
  });

  it('groups events by sdk and version', () => {
    const events = [
      makeEvent({ sdk: 'bridge-core', sdkVersion: '0.1.0' }),
      makeEvent({ sdk: 'bridge-core', sdkVersion: '0.1.0' }),
      makeEvent({ sdk: 'ui', sdkVersion: '1.0.0' }),
    ];
    const stats = agg.aggregateBySdk(events);
    expect(stats).toHaveLength(2);
    const core = stats.find((s) => s.sdk === 'bridge-core')!;
    expect(core.totalCalls).toBe(2);
  });

  it('calculates success rate correctly', () => {
    const events = [
      makeEvent({ success: true }),
      makeEvent({ success: true }),
      makeEvent({ success: false }),
    ];
    const [stats] = agg.aggregateBySdk(events);
    expect(stats.successRate).toBeCloseTo(2 / 3);
  });

  it('calculates avg/min/max/p50/p95 duration', () => {
    const events = [10, 20, 30, 40, 100].map((d) =>
      makeEvent({ durationMs: d }),
    );
    const [methodStats] = agg.aggregateByMethod(events);
    expect(methodStats.minDurationMs).toBe(10);
    expect(methodStats.maxDurationMs).toBe(100);
    expect(methodStats.avgDurationMs).toBe(40);
    expect(methodStats.p50DurationMs).toBe(30);
    expect(methodStats.p95DurationMs).toBe(100);
  });

  it('counts unique sessions', () => {
    const events = [
      makeEvent({ sessionId: 'a' }),
      makeEvent({ sessionId: 'a' }),
      makeEvent({ sessionId: 'b' }),
    ];
    const [stats] = agg.aggregateBySdk(events);
    expect(stats.uniqueSessions).toBe(2);
  });

  it('groups by method correctly', () => {
    const events = [
      makeEvent({ method: 'getQuote' }),
      makeEvent({ method: 'getQuote' }),
      makeEvent({ method: 'executeTransfer' }),
    ];
    const methods = agg.aggregateByMethod(events);
    const getQuote = methods.find((m) => m.method === 'getQuote')!;
    expect(getQuote.callCount).toBe(2);
  });
});
