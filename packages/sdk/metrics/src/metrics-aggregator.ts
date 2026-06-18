import { SdkTelemetryEvent, MethodStats, SdkStats } from './types';

/** Return the value at the given percentile (0–100) of a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * MetricsAggregator — computes MethodStats and SdkStats from raw events.
 *
 * Stateless: pass events in, get aggregated stats out.
 */
export class MetricsAggregator {
  /**
   * Aggregate raw events into per-SDK stats.
   * @param events - Telemetry events to aggregate (may span multiple SDKs).
   */
  aggregateBySdk(events: SdkTelemetryEvent[]): SdkStats[] {
    const byKey = new Map<string, SdkTelemetryEvent[]>();

    for (const event of events) {
      const key = `${event.sdk}@${event.sdkVersion}`;
      const bucket = byKey.get(key) ?? [];
      bucket.push(event);
      byKey.set(key, bucket);
    }

    return Array.from(byKey.entries()).map(([, sdkEvents]) => {
      const first = sdkEvents[0];
      const methodStats = this.aggregateByMethod(sdkEvents);
      const sessions = new Set(sdkEvents.map((e) => e.sessionId).filter(Boolean));
      const successCount = sdkEvents.filter((e) => e.success).length;

      return {
        sdk: first.sdk,
        sdkVersion: first.sdkVersion,
        totalCalls: sdkEvents.length,
        successRate: sdkEvents.length > 0 ? successCount / sdkEvents.length : 0,
        avgDurationMs: this.avg(sdkEvents.map((e) => e.durationMs)),
        uniqueSessions: sessions.size,
        methods: methodStats,
      };
    });
  }

  /**
   * Aggregate events by method name, regardless of SDK.
   */
  aggregateByMethod(events: SdkTelemetryEvent[]): MethodStats[] {
    const byMethod = new Map<string, SdkTelemetryEvent[]>();

    for (const event of events) {
      const bucket = byMethod.get(event.method) ?? [];
      bucket.push(event);
      byMethod.set(event.method, bucket);
    }

    return Array.from(byMethod.entries()).map(([method, methodEvents]) => {
      const durations = methodEvents.map((e) => e.durationMs).sort((a, b) => a - b);
      const successCount = methodEvents.filter((e) => e.success).length;

      return {
        method,
        callCount: methodEvents.length,
        successCount,
        errorCount: methodEvents.length - successCount,
        successRate: methodEvents.length > 0 ? successCount / methodEvents.length : 0,
        avgDurationMs: this.avg(durations),
        minDurationMs: durations[0] ?? 0,
        maxDurationMs: durations[durations.length - 1] ?? 0,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
      };
    });
  }

  private avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
  }
}
