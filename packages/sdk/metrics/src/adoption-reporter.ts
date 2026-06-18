import { MetricsCollector } from './metrics-collector';
import { MetricsAggregator } from './metrics-aggregator';
import { SdkAdoptionReport, MethodStats } from './types';

/**
 * AdoptionReporter — generates structured adoption reports from collected telemetry.
 *
 * Usage:
 *   const report = AdoptionReporter.generate();
 *   const report = AdoptionReporter.generate({ startDate: new Date('2025-01-01') });
 */
export class AdoptionReporter {
  private readonly collector: MetricsCollector;
  private readonly aggregator: MetricsAggregator;

  constructor(
    collector: MetricsCollector = MetricsCollector.getInstance(),
    aggregator: MetricsAggregator = new MetricsAggregator(),
  ) {
    this.collector = collector;
    this.aggregator = aggregator;
  }

  /**
   * Generate a full adoption report from buffered events.
   * @param options.startDate - Only include events at or after this date.
   * @param options.endDate   - Only include events before or at this date.
   */
  generate(options: { startDate?: Date; endDate?: Date } = {}): SdkAdoptionReport {
    const { startDate, endDate = new Date() } = options;
    const startMs = startDate?.getTime() ?? 0;
    const endMs = endDate.getTime();

    const allEvents = this.collector.getEvents().filter(
      (e) => e.timestamp >= startMs && e.timestamp <= endMs,
    );

    const sdkStats = this.aggregator.aggregateBySdk(allEvents);
    const allMethodStats = this.aggregator.aggregateByMethod(allEvents);

    const topMethods: MethodStats[] = [...allMethodStats]
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 5);

    const totalSessions = new Set(
      allEvents.map((e) => e.sessionId).filter(Boolean),
    ).size;

    const totalErrors = allEvents.filter((e) => !e.success).length;
    const overallErrorRate = allEvents.length > 0 ? totalErrors / allEvents.length : 0;

    return {
      generatedAt: new Date().toISOString(),
      periodStart: startDate ? startDate.toISOString() : new Date(startMs).toISOString(),
      periodEnd: endDate.toISOString(),
      totalEvents: allEvents.length,
      totalSdks: sdkStats.length,
      totalUniqueSessions: totalSessions,
      sdks: sdkStats,
      topMethods,
      overallErrorRate,
    };
  }

  /**
   * Convenience: generate and return as a formatted JSON string.
   */
  toJSON(options?: { startDate?: Date; endDate?: Date }): string {
    return JSON.stringify(this.generate(options), null, 2);
  }
}
