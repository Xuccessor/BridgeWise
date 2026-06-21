import { StellarRoutePerformanceIndex } from './stellar-route-performance-index';
import { RouteHistoryEntry } from '../../../history/routes/stellar/route-history';
import { StellarRouteCongestion } from '../../../analytics/congestion/stellar/stellar-route-congestion-analyzer';

const makeEntry = (routeId: string, durationMs: number, success: boolean): RouteHistoryEntry => ({
  routeId,
  fromAsset: 'XLM',
  toAsset: 'USDC',
  executedAt: new Date(),
  durationMs,
  success,
});

describe('StellarRoutePerformanceIndex', () => {
  let index: StellarRoutePerformanceIndex;

  beforeEach(() => {
    index = new StellarRoutePerformanceIndex();
  });

  describe('aggregateLatency', () => {
    it('returns average duration from history when no congestion data', () => {
      const history = [makeEntry('r1', 200, true), makeEntry('r1', 400, true)];
      const result = index.aggregateLatency(history, []);
      expect(result).toHaveLength(1);
      expect(result[0].routeId).toBe('r1');
      expect(result[0].averageLatencyMs).toBe(300);
      expect(result[0].sampleCount).toBe(2);
    });

    it('blends history average with congestion average latency', () => {
      const history = [makeEntry('r1', 200, true)];
      const congestion: StellarRouteCongestion[] = [{ routeId: 'r1', averageLatencyMs: 400, spike: false }];
      const result = index.aggregateLatency(history, congestion);
      expect(result[0].averageLatencyMs).toBe(300); // (200 + 400) / 2
    });

    it('groups metrics by routeId', () => {
      const history = [makeEntry('r1', 100, true), makeEntry('r2', 500, false)];
      const result = index.aggregateLatency(history, []);
      expect(result).toHaveLength(2);
    });
  });

  describe('aggregateSuccess', () => {
    it('calculates correct success rate', () => {
      const history = [
        makeEntry('r1', 100, true),
        makeEntry('r1', 100, true),
        makeEntry('r1', 100, false),
      ];
      const result = index.aggregateSuccess(history);
      expect(result[0].successRate).toBeCloseTo(2 / 3);
      expect(result[0].totalExecutions).toBe(3);
    });

    it('returns 0 success rate when all executions failed', () => {
      const history = [makeEntry('r1', 100, false), makeEntry('r1', 100, false)];
      const result = index.aggregateSuccess(history);
      expect(result[0].successRate).toBe(0);
    });
  });

  describe('score', () => {
    it('returns a score between 0 and 1', () => {
      const history = [makeEntry('r1', 500, true), makeEntry('r1', 500, false)];
      const scores = index.score(history);
      expect(scores[0].score).toBeGreaterThanOrEqual(0);
      expect(scores[0].score).toBeLessThanOrEqual(1);
    });

    it('scores a route with 100% success and low latency highly', () => {
      const history = [makeEntry('r1', 100, true), makeEntry('r1', 100, true)];
      const scores = index.score(history);
      expect(scores[0].score).toBeGreaterThan(0.8);
    });

    it('scores a route with 0% success and high latency lowly', () => {
      const history = [makeEntry('r1', 9999, false), makeEntry('r1', 9999, false)];
      const scores = index.score(history);
      expect(scores[0].score).toBeLessThan(0.1);
    });

    it('respects custom weights', () => {
      const custom = new StellarRoutePerformanceIndex({ successWeight: 1, latencyWeight: 0 });
      const history = [makeEntry('r1', 9999, true)]; // bad latency, perfect success
      const scores = custom.score(history);
      expect(scores[0].score).toBeCloseTo(1);
    });

    it('returns empty array for empty history', () => {
      expect(index.score([])).toEqual([]);
    });
  });
});
