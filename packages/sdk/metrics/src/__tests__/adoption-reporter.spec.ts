import { MetricsCollector } from '../metrics-collector';
import { MetricsAggregator } from '../metrics-aggregator';
import { AdoptionReporter } from '../adoption-reporter';
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

describe('AdoptionReporter', () => {
  let collector: MetricsCollector;
  let reporter: AdoptionReporter;

  beforeEach(() => {
    collector = MetricsCollector.getInstance();
    collector.reset();
    reporter = new AdoptionReporter(collector, new MetricsAggregator());
  });

  it('generates a report with correct structure', () => {
    collector.record(makeEvent());
    const report = reporter.generate();
    expect(report).toHaveProperty('generatedAt');
    expect(report).toHaveProperty('totalEvents', 1);
    expect(report).toHaveProperty('totalSdks', 1);
    expect(report).toHaveProperty('sdks');
    expect(report).toHaveProperty('topMethods');
    expect(report).toHaveProperty('overallErrorRate');
  });

  it('returns zero-state report when no events are collected', () => {
    const report = reporter.generate();
    expect(report.totalEvents).toBe(0);
    expect(report.totalSdks).toBe(0);
    expect(report.overallErrorRate).toBe(0);
  });

  it('calculates overall error rate correctly', () => {
    collector.record(makeEvent({ success: true }));
    collector.record(makeEvent({ success: false }));
    const report = reporter.generate();
    expect(report.overallErrorRate).toBeCloseTo(0.5);
  });

  it('filters events by date range', () => {
    const past = Date.now() - 10_000;
    const recent = Date.now();
    collector.record(makeEvent({ timestamp: past, method: 'old' }));
    collector.record(makeEvent({ timestamp: recent, method: 'new' }));

    const report = reporter.generate({ startDate: new Date(recent - 1) });
    expect(report.totalEvents).toBe(1);
    expect(report.topMethods[0].method).toBe('new');
  });

  it('lists top 5 methods by call count', () => {
    const methods = ['a', 'b', 'c', 'd', 'e', 'f'];
    methods.forEach((method, i) => {
      for (let j = 0; j <= i; j++) {
        collector.record(makeEvent({ method }));
      }
    });
    const report = reporter.generate();
    expect(report.topMethods).toHaveLength(5);
    expect(report.topMethods[0].callCount).toBeGreaterThanOrEqual(
      report.topMethods[1].callCount,
    );
  });

  it('counts unique sessions across all SDKs', () => {
    collector.record(makeEvent({ sessionId: 'x', sdk: 'bridge-core' }));
    collector.record(makeEvent({ sessionId: 'x', sdk: 'ui' }));
    collector.record(makeEvent({ sessionId: 'y', sdk: 'ui' }));
    const report = reporter.generate();
    expect(report.totalUniqueSessions).toBe(2);
  });

  it('toJSON returns valid JSON', () => {
    collector.record(makeEvent());
    expect(() => JSON.parse(reporter.toJSON())).not.toThrow();
  });
});
