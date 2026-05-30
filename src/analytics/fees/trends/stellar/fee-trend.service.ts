import * as crypto from 'crypto';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StellarFeeRecord {
  id: string;
  timestamp: Date;
  routeId: string;
  networkFee: string;
  totalFeeUsd: number;
}

export interface FeeTrendInsight {
  routeId: string;
  periodDays: number;
  averageFeeUsd: number;
  highestFeeUsd: number;
  lowestFeeUsd: number;
  medianFeeUsd: number;
  trendDirection: 'increasing' | 'decreasing' | 'stable';
  percentageChange: number;
  volatilityScore: number;       // std deviation as % of mean — higher = more volatile
  sampleCount: number;
  firstRecordedAt: Date;
  lastRecordedAt: Date;
}

export interface RouteComparison {
  routeId: string;
  averageFeeUsd: number;
  trendDirection: FeeTrendInsight['trendDirection'];
  percentageChange: number;
  volatilityScore: number;
  sampleCount: number;
}

export interface FeeAlert {
  routeId: string;
  type: 'spike' | 'drop' | 'high_volatility';
  message: string;
  triggeredAt: Date;
  feeUsd: number;
  thresholdUsd: number;
}

export interface AnalyzerStats {
  totalRecords: number;
  uniqueRoutes: number;
  oldestRecord: Date | null;
  newestRecord: Date | null;
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface StellarFeeTrendAnalyzerOptions {
  /** % change above the rolling average that triggers a spike alert. Default: 50 */
  spikeThresholdPct?: number;
  /** % drop below the rolling average that triggers a drop alert. Default: 30 */
  dropThresholdPct?: number;
  /** Volatility score above which a high_volatility alert fires. Default: 20 */
  volatilityAlertThreshold?: number;
  /** Max records to keep per route (oldest pruned first). Default: unlimited */
  maxRecordsPerRoute?: number;
}

// ─── Analyzer ─────────────────────────────────────────────────────────────────

export class StellarFeeTrendAnalyzer {
  private records: StellarFeeRecord[] = [];
  private alerts: FeeAlert[] = [];
  private readonly options: Required<StellarFeeTrendAnalyzerOptions>;

  constructor(options: StellarFeeTrendAnalyzerOptions = {}) {
    this.options = {
      spikeThresholdPct: options.spikeThresholdPct ?? 50,
      dropThresholdPct: options.dropThresholdPct ?? 30,
      volatilityAlertThreshold: options.volatilityAlertThreshold ?? 20,
      maxRecordsPerRoute: options.maxRecordsPerRoute ?? Infinity,
    };
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /**
   * Records a new fee data point and evaluates alert conditions.
   */
  recordFee(
    data: Omit<StellarFeeRecord, 'id' | 'timestamp'> & { timestamp?: Date }
  ): StellarFeeRecord {
    if (data.totalFeeUsd < 0) {
      throw new Error(`totalFeeUsd must be non-negative, got ${data.totalFeeUsd}`);
    }
    if (!data.routeId?.trim()) {
      throw new Error('routeId must be a non-empty string');
    }

    const record: StellarFeeRecord = {
      id: crypto.randomUUID(),
      timestamp: data.timestamp ?? new Date(),
      routeId: data.routeId.trim(),
      networkFee: data.networkFee,
      totalFeeUsd: data.totalFeeUsd,
    };

    this.records.push(record);
    this.pruneRoute(record.routeId);
    this.evaluateAlerts(record);

    return record;
  }

  /**
   * Bulk-insert records (e.g. from historical data import).
   */
  importRecords(
    data: Array<Omit<StellarFeeRecord, 'id'> & { id?: string }>
  ): StellarFeeRecord[] {
    return data.map((d) =>
      this.recordFee({
        routeId: d.routeId,
        networkFee: d.networkFee,
        totalFeeUsd: d.totalFeeUsd,
        timestamp: d.timestamp,
      })
    );
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  /** All stored records, newest first. */
  getAllRecords(): StellarFeeRecord[] {
    return [...this.records].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
  }

  /** Records for a specific route, newest first. */
  getRecordsByRoute(routeId: string): StellarFeeRecord[] {
    return this.records
      .filter((r) => r.routeId === routeId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /** All unique route IDs seen. */
  getRouteIds(): string[] {
    return [...new Set(this.records.map((r) => r.routeId))];
  }

  /** General analyzer health stats. */
  getStats(): AnalyzerStats {
    if (this.records.length === 0) {
      return { totalRecords: 0, uniqueRoutes: 0, oldestRecord: null, newestRecord: null };
    }
    const timestamps = this.records.map((r) => r.timestamp.getTime());
    return {
      totalRecords: this.records.length,
      uniqueRoutes: this.getRouteIds().length,
      oldestRecord: new Date(Math.min(...timestamps)),
      newestRecord: new Date(Math.max(...timestamps)),
    };
  }

  // ─── Insights ──────────────────────────────────────────────────────────────

  /**
   * Full trend insight for a single route over a rolling time window.
   * Returns null if no data exists for the given route/period.
   */
  getFeeInsights(routeId: string, days: number = 7): FeeTrendInsight | null {
    if (days <= 0) throw new Error('days must be a positive number');

    const filtered = this.getWindowRecords(routeId, days);
    if (filtered.length === 0) return null;

    const fees = filtered.map((r) => r.totalFeeUsd);
    const average = mean(fees);
    const { trendDirection, percentageChange } = this.computeTrend(filtered);

    return {
      routeId,
      periodDays: days,
      averageFeeUsd: round(average),
      highestFeeUsd: round(Math.max(...fees)),
      lowestFeeUsd: round(Math.min(...fees)),
      medianFeeUsd: round(median(fees)),
      trendDirection,
      percentageChange: round(percentageChange, 2),
      volatilityScore: round(volatility(fees), 2),
      sampleCount: filtered.length,
      firstRecordedAt: filtered[0].timestamp,
      lastRecordedAt: filtered[filtered.length - 1].timestamp,
    };
  }

  /**
   * Compare multiple routes side-by-side, sorted by average fee ascending.
   */
  compareRoutes(routeIds: string[], days: number = 7): RouteComparison[] {
    return routeIds
      .map((routeId): RouteComparison | null => {
        const insight = this.getFeeInsights(routeId, days);
        if (!insight) return null;
        return {
          routeId,
          averageFeeUsd: insight.averageFeeUsd,
          trendDirection: insight.trendDirection,
          percentageChange: insight.percentageChange,
          volatilityScore: insight.volatilityScore,
          sampleCount: insight.sampleCount,
        };
      })
      .filter((r): r is RouteComparison => r !== null)
      .sort((a, b) => a.averageFeeUsd - b.averageFeeUsd);
  }

  /**
   * Returns the cheapest route from a list, based on average fee over the window.
   */
  cheapestRoute(routeIds: string[], days: number = 7): RouteComparison | null {
    const comparisons = this.compareRoutes(routeIds, days);
    return comparisons[0] ?? null;
  }

  // ─── Alerts ────────────────────────────────────────────────────────────────

  /** All alerts fired so far, newest first. */
  getAlerts(routeId?: string): FeeAlert[] {
    const all = [...this.alerts].sort(
      (a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime()
    );
    return routeId ? all.filter((a) => a.routeId === routeId) : all;
  }

  /** Clear all alerts. */
  clearAlerts(): void {
    this.alerts = [];
  }

  // ─── Maintenance ───────────────────────────────────────────────────────────

  /** Remove all records (and optionally alerts). */
  clearRecords(clearAlertsAlso = false): void {
    this.records = [];
    if (clearAlertsAlso) this.alerts = [];
  }

  /** Remove records older than `days` across all routes. */
  pruneOlderThan(days: number): number {
    const cutoff = cutoffDate(days);
    const before = this.records.length;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
    return before - this.records.length;
  }

  /** Export all records as JSON string (for persistence). */
  exportJSON(): string {
    return JSON.stringify(this.records);
  }

  /** Import records from a JSON string (e.g. loaded from disk/DB). */
  importJSON(json: string): void {
    const parsed: StellarFeeRecord[] = JSON.parse(json);
    parsed.forEach((r) => {
      this.records.push({ ...r, timestamp: new Date(r.timestamp) });
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private getWindowRecords(routeId: string, days: number): StellarFeeRecord[] {
    const cutoff = cutoffDate(days);
    return this.records
      .filter((r) => r.routeId === routeId && r.timestamp >= cutoff)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  private computeTrend(
    sorted: StellarFeeRecord[]
  ): Pick<FeeTrendInsight, 'trendDirection' | 'percentageChange'> {
    if (sorted.length < 2) {
      return { trendDirection: 'stable', percentageChange: 0 };
    }

    const mid = Math.floor(sorted.length / 2);
    const firstHalfAvg = mean(sorted.slice(0, mid).map((r) => r.totalFeeUsd));
    const secondHalfAvg = mean(sorted.slice(mid).map((r) => r.totalFeeUsd));

    const percentageChange =
      firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;

    const trendDirection =
      percentageChange > 1
        ? 'increasing'
        : percentageChange < -1
        ? 'decreasing'
        : 'stable';

    return { trendDirection, percentageChange };
  }

  private evaluateAlerts(record: StellarFeeRecord): void {
    const recentRecords = this.getWindowRecords(record.routeId, 7);
    if (recentRecords.length < 2) return;

    const fees = recentRecords.slice(0, -1).map((r) => r.totalFeeUsd); // exclude current
    const rollingAvg = mean(fees);
    const current = record.totalFeeUsd;

    // Spike alert
    const spikeThreshold = rollingAvg * (1 + this.options.spikeThresholdPct / 100);
    if (current > spikeThreshold) {
      this.alerts.push({
        routeId: record.routeId,
        type: 'spike',
        message: `Fee spike on route "${record.routeId}": $${current.toFixed(4)} is ${this.options.spikeThresholdPct}%+ above the rolling average ($${rollingAvg.toFixed(4)})`,
        triggeredAt: record.timestamp,
        feeUsd: current,
        thresholdUsd: round(spikeThreshold),
      });
    }

    // Drop alert
    const dropThreshold = rollingAvg * (1 - this.options.dropThresholdPct / 100);
    if (current < dropThreshold) {
      this.alerts.push({
        routeId: record.routeId,
        type: 'drop',
        message: `Fee drop on route "${record.routeId}": $${current.toFixed(4)} is ${this.options.dropThresholdPct}%+ below the rolling average ($${rollingAvg.toFixed(4)})`,
        triggeredAt: record.timestamp,
        feeUsd: current,
        thresholdUsd: round(dropThreshold),
      });
    }

    // Volatility alert
    const vol = volatility([...fees, current]);
    if (vol > this.options.volatilityAlertThreshold) {
      this.alerts.push({
        routeId: record.routeId,
        type: 'high_volatility',
        message: `High fee volatility on route "${record.routeId}": volatility score ${vol.toFixed(2)}% exceeds threshold of ${this.options.volatilityAlertThreshold}%`,
        triggeredAt: record.timestamp,
        feeUsd: current,
        thresholdUsd: rollingAvg,
      });
    }
  }

  private pruneRoute(routeId: string): void {
    if (this.options.maxRecordsPerRoute === Infinity) return;
    const routeRecords = this.records
      .filter((r) => r.routeId === routeId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (routeRecords.length > this.options.maxRecordsPerRoute) {
      const toRemove = new Set(
        routeRecords
          .slice(0, routeRecords.length - this.options.maxRecordsPerRoute)
          .map((r) => r.id)
      );
      this.records = this.records.filter((r) => !toRemove.has(r.id));
    }
  }
}

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Coefficient of variation as a percentage (std dev / mean * 100). */
function volatility(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  if (avg === 0) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return (Math.sqrt(variance) / avg) * 100;
}

function round(value: number, decimals = 4): number {
  return Number(value.toFixed(decimals));
}

function cutoffDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}