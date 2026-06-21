import { RouteHistoryEntry } from '../../../history/routes/stellar/route-history';
import { StellarRouteCongestion } from '../../../analytics/congestion/stellar/stellar-route-congestion-analyzer';
import {
  RouteLatencyMetrics,
  RoutePerformanceScore,
  RouteSuccessMetrics,
  StellarRoutePerformanceIndexOptions,
} from './types';

const DEFAULT_OPTIONS: Required<StellarRoutePerformanceIndexOptions> = {
  successWeight: 0.6,
  latencyWeight: 0.4,
  maxLatencyMs: 10_000,
};

export class StellarRoutePerformanceIndex {
  private readonly options: Required<StellarRoutePerformanceIndexOptions>;

  constructor(options: StellarRoutePerformanceIndexOptions = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const total = merged.successWeight + merged.latencyWeight;
    this.options = {
      ...merged,
      successWeight: merged.successWeight / total,
      latencyWeight: merged.latencyWeight / total,
    };
  }

  aggregateLatency(
    history: RouteHistoryEntry[],
    congestion: StellarRouteCongestion[]
  ): RouteLatencyMetrics[] {
    const congestionMap = new Map(congestion.map((c) => [c.routeId, c.averageLatencyMs]));

    const grouped = new Map<string, number[]>();
    for (const entry of history) {
      const latencies = grouped.get(entry.routeId) ?? [];
      latencies.push(entry.durationMs);
      grouped.set(entry.routeId, latencies);
    }

    const result: RouteLatencyMetrics[] = [];
    for (const [routeId, latencies] of grouped.entries()) {
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const congestionLatency = congestionMap.get(routeId);
      const averageLatencyMs = congestionLatency !== undefined
        ? (avg + congestionLatency) / 2
        : avg;

      result.push({ routeId, averageLatencyMs: Math.round(averageLatencyMs), sampleCount: latencies.length });
    }
    return result;
  }

  aggregateSuccess(history: RouteHistoryEntry[]): RouteSuccessMetrics[] {
    const grouped = new Map<string, { success: number; total: number }>();
    for (const entry of history) {
      const stats = grouped.get(entry.routeId) ?? { success: 0, total: 0 };
      stats.total += 1;
      if (entry.success) stats.success += 1;
      grouped.set(entry.routeId, stats);
    }

    return Array.from(grouped.entries()).map(([routeId, stats]) => ({
      routeId,
      successRate: stats.total === 0 ? 0 : stats.success / stats.total,
      totalExecutions: stats.total,
    }));
  }

  score(
    history: RouteHistoryEntry[],
    congestion: StellarRouteCongestion[] = []
  ): RoutePerformanceScore[] {
    const latencyMetrics = this.aggregateLatency(history, congestion);
    const successMetrics = this.aggregateSuccess(history);

    const successMap = new Map(successMetrics.map((m) => [m.routeId, m]));

    return latencyMetrics.map((lm) => {
      const sm = successMap.get(lm.routeId) ?? {
        routeId: lm.routeId,
        successRate: 0,
        totalExecutions: 0,
      };

      const normalizedLatency = Math.max(
        0,
        1 - lm.averageLatencyMs / this.options.maxLatencyMs
      );

      const score =
        this.options.successWeight * sm.successRate +
        this.options.latencyWeight * normalizedLatency;

      return { routeId: lm.routeId, score: Math.round(score * 1000) / 1000, latencyMetrics: lm, successMetrics: sm };
    });
  }
}
