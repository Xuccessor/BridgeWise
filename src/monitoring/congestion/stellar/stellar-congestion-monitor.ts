/**
 * Stellar Congestion Monitor
 * Tracks route congestion metrics, detects congestion spikes, and generates alerts
 */

import { EventEmitter } from 'events';
import type {
  CongestionAlert,
  CongestionMetrics,
  CongestionProbe,
  CongestionProbeResult,
  CongestionStatus,
  CongestionThresholds,
  StellarCongestionMonitorConfig,
} from './types';

const DEFAULT_CONFIG: Required<Omit<StellarCongestionMonitorConfig, 'onAlert' | 'onStatusChange' | 'onError'>> = {
  checkIntervalMs: 30_000,
  timeoutMs: 5_000,
  historyWindowSize: 100,
  spikeMultiplier: 2.0,
  minDataPoints: 5,
  thresholds: {
    latencyMs: 5_000,
    failureRate: 0.3,
    queueDepth: 100,
    throughput: 10,
    pendingTransactions: 500,
  },
};

export class StellarCongestionMonitor extends EventEmitter {
  private readonly config: Required<Omit<StellarCongestionMonitorConfig, 'onAlert' | 'onStatusChange' | 'onError'>> &
    Pick<StellarCongestionMonitorConfig, 'onAlert' | 'onStatusChange' | 'onError'>;

  private readonly probes = new Map<string, CongestionProbe>();
  private readonly metricsHistory = new Map<string, CongestionMetrics[]>();
  private readonly statuses = new Map<string, CongestionStatus>();
  private readonly activeAlerts = new Map<string, CongestionAlert>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: StellarCongestionMonitorConfig = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        ...config.thresholds,
      },
    };
  }

  /**
   * Register a route for congestion monitoring
   */
  registerRoute(routeId: string, probe: CongestionProbe): void {
    this.probes.set(routeId, probe);
    if (!this.metricsHistory.has(routeId)) {
      this.metricsHistory.set(routeId, []);
    }
    if (!this.statuses.has(routeId)) {
      this.statuses.set(routeId, {
        routeId,
        status: 'normal',
        currentMetrics: this.createEmptyMetrics(routeId),
        alertHistory: [],
        lastUpdated: new Date(),
      });
    }
  }

  /**
   * Unregister a route from congestion monitoring
   */
  unregisterRoute(routeId: string): boolean {
    this.metricsHistory.delete(routeId);
    this.statuses.delete(routeId);
    this.activeAlerts.delete(routeId);
    return this.probes.delete(routeId);
  }

  /**
   * Reset all monitoring data
   */
  reset(): void {
    this.stopMonitoring();
    this.probes.clear();
    this.metricsHistory.clear();
    this.statuses.clear();
    this.activeAlerts.clear();
  }

  /**
   * Get current congestion status for a route
   */
  getRouteStatus(routeId: string): CongestionStatus | null {
    return this.statuses.get(routeId) || null;
  }

  /**
   * Get congestion statuses for all monitored routes
   */
  getAllStatuses(): CongestionStatus[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Get active alerts for a route
   */
  getActiveAlerts(routeId: string): CongestionAlert[] {
    return this.statuses.get(routeId)?.alertHistory.filter(a => !a.resolvedAt) || [];
  }

  /**
   * Get all active alerts across all routes
   */
  getAllActiveAlerts(): CongestionAlert[] {
    const alerts: CongestionAlert[] = [];
    for (const status of this.statuses.values()) {
      alerts.push(...status.alertHistory.filter(a => !a.resolvedAt));
    }
    return alerts;
  }

  /**
   * Start continuous congestion monitoring
   */
  startMonitoring(): void {
    if (this.checkInterval) {
      return;
    }

    this.checkInterval = setInterval(() => {
      void this.checkAll();
    }, this.config.checkIntervalMs);

    void this.checkAll();
  }

  /**
   * Stop continuous congestion monitoring
   */
  stopMonitoring(): void {
    if (!this.checkInterval) {
      return;
    }

    clearInterval(this.checkInterval);
    this.checkInterval = null;
  }

  /**
   * Check all registered routes for congestion
   */
  async checkAll(): Promise<void> {
    const routeIds = Array.from(this.probes.keys());
    await Promise.all(routeIds.map((routeId) => this.checkRoute(routeId)));
  }

  /**
   * Check a specific route for congestion
   */
  async checkRoute(routeId: string): Promise<CongestionStatus | null> {
    const probe = this.probes.get(routeId);
    if (!probe) {
      return null;
    }

    let result: CongestionProbeResult;
    try {
      result = await this.withTimeout(
        probe(),
        this.config.timeoutMs,
        `Congestion probe timed out for route ${routeId}`,
      );
    } catch (error: any) {
      result = {
        latencyMs: this.config.timeoutMs,
        failureRate: 1.0,
        queueDepth: 0,
        throughput: 0,
        pendingTransactions: 0,
      };
    }

    const metrics: CongestionMetrics = {
      routeId,
      timestamp: new Date(),
      latencyMs: result.latencyMs,
      failureRate: result.failureRate,
      queueDepth: result.queueDepth,
      throughput: result.throughput,
      pendingTransactions: result.pendingTransactions,
    };

    this.recordMetrics(routeId, metrics);
    const previousStatus = this.statuses.get(routeId)?.status || 'normal';
    const status = this.evaluateCongestionStatus(routeId, metrics);
    this.updateStatus(routeId, metrics, status);

    const currentStatus = this.statuses.get(routeId)!;
    if (previousStatus !== currentStatus.status) {
      this.emitStatusChange(currentStatus);
    }

    this.detectAndGenerateAlerts(routeId, metrics, currentStatus);

    return currentStatus;
  }

  /**
   * Update thresholds dynamically
   */
  updateThresholds(thresholds: Partial<CongestionThresholds>): void {
    this.config.thresholds = {
      ...this.config.thresholds,
      ...thresholds,
    };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): Required<CongestionThresholds> {
    return this.config.thresholds as Required<CongestionThresholds>;
  }

  private createEmptyMetrics(routeId: string): CongestionMetrics {
    return {
      routeId,
      timestamp: new Date(),
      latencyMs: 0,
      failureRate: 0,
      queueDepth: 0,
      throughput: 0,
      pendingTransactions: 0,
    };
  }

  private recordMetrics(routeId: string, metrics: CongestionMetrics): void {
    const history = this.metricsHistory.get(routeId);
    if (!history) {
      return;
    }

    history.push(metrics);

    while (history.length > this.config.historyWindowSize) {
      history.shift();
    }
  }

  private evaluateCongestionStatus(routeId: string, metrics: CongestionMetrics): CongestionStatus['status'] {
    const thresholds = this.config.thresholds;
    const breachCount = this.countThresholdBreaches(metrics, thresholds);

    if (breachCount >= 3) {
      return 'severe';
    }

    if (breachCount >= 2) {
      return 'congested';
    }

    if (breachCount >= 1) {
      return 'elevated';
    }

    if (this.detectSpike(routeId)) {
      return 'elevated';
    }

    return 'normal';
  }

  private countThresholdBreaches(metrics: CongestionMetrics, thresholds: Required<CongestionThresholds>): number {
    let count = 0;

    if (metrics.latencyMs > thresholds.latencyMs) count++;
    if (metrics.failureRate > thresholds.failureRate) count++;
    if (metrics.queueDepth > thresholds.queueDepth) count++;
    if (metrics.throughput < thresholds.throughput) count++;
    if (metrics.pendingTransactions > thresholds.pendingTransactions) count++;

    return count;
  }

  private detectSpike(routeId: string): boolean {
    const history = this.metricsHistory.get(routeId);
    if (!history || history.length < this.config.minDataPoints) {
      return false;
    }

    const current = history[history.length - 1];
    const historical = history.slice(0, -1);

    const avgLatency = historical.reduce((sum, m) => sum + m.latencyMs, 0) / historical.length;
    if (current.latencyMs > avgLatency * this.config.spikeMultiplier) {
      return true;
    }

    const avgFailureRate = historical.reduce((sum, m) => sum + m.failureRate, 0) / historical.length;
    if (avgFailureRate > 0 && current.failureRate > avgFailureRate * this.config.spikeMultiplier) {
      return true;
    }

    const avgQueueDepth = historical.reduce((sum, m) => sum + m.queueDepth, 0) / historical.length;
    if (avgQueueDepth > 0 && current.queueDepth > avgQueueDepth * this.config.spikeMultiplier) {
      return true;
    }

    return false;
  }

  private updateStatus(routeId: string, metrics: CongestionMetrics, status: CongestionStatus['status']): void {
    const existing = this.statuses.get(routeId);
    if (!existing) {
      return;
    }

    const updated: CongestionStatus = {
      ...existing,
      status,
      currentMetrics: metrics,
      lastUpdated: new Date(),
    };

    this.statuses.set(routeId, updated);
  }

  private detectAndGenerateAlerts(routeId: string, metrics: CongestionMetrics, status: CongestionStatus): void {
    const thresholds = this.config.thresholds;
    const existingAlertKey = this.activeAlerts.get(routeId)?.metric;

    const thresholdChecks: Array<{
      metric: 'latency' | 'failureRate' | 'queueDepth' | 'throughput' | 'pendingTransactions';
      currentValue: number;
      threshold: number;
      exceeds: boolean;
      severity: CongestionAlert['severity'];
      message: (value: number, threshold: number) => string;
    }> = [
      {
        metric: 'latency',
        currentValue: metrics.latencyMs,
        threshold: thresholds.latencyMs,
        exceeds: metrics.latencyMs > thresholds.latencyMs,
        severity: this.getLatencySeverity(metrics.latencyMs, thresholds.latencyMs),
        message: (v, t) => `Latency spike detected: ${v.toFixed(0)}ms exceeds threshold of ${t}ms`,
      },
      {
        metric: 'failureRate',
        currentValue: metrics.failureRate,
        threshold: thresholds.failureRate,
        exceeds: metrics.failureRate > thresholds.failureRate,
        severity: this.getRateSeverity(metrics.failureRate, thresholds.failureRate),
        message: (v, t) => `Failure rate elevated: ${(v * 100).toFixed(1)}% exceeds threshold of ${(t * 100).toFixed(1)}%`,
      },
      {
        metric: 'queueDepth',
        currentValue: metrics.queueDepth,
        threshold: thresholds.queueDepth,
        exceeds: metrics.queueDepth > thresholds.queueDepth,
        severity: this.getValueSeverity(metrics.queueDepth, thresholds.queueDepth),
        message: (v, t) => `Queue depth elevated: ${v.toFixed(0)} exceeds threshold of ${t}`,
      },
      {
        metric: 'throughput',
        currentValue: metrics.throughput,
        threshold: thresholds.throughput,
        exceeds: metrics.throughput < thresholds.throughput,
        severity: this.getThroughputSeverity(metrics.throughput, thresholds.throughput),
        message: (v, t) => `Throughput dropped: ${v.toFixed(0)} below threshold of ${t}`,
      },
      {
        metric: 'pendingTransactions',
        currentValue: metrics.pendingTransactions,
        threshold: thresholds.pendingTransactions,
        exceeds: metrics.pendingTransactions > thresholds.pendingTransactions,
        severity: this.getValueSeverity(metrics.pendingTransactions, thresholds.pendingTransactions),
        message: (v, t) => `Pending transactions elevated: ${v.toFixed(0)} exceeds threshold of ${t}`,
      },
    ];

    for (const check of thresholdChecks) {
      if (!check.exceeds) {
        continue;
      }

      const alertKey = `${routeId}-${check.metric}`;
      const existing = this.activeAlerts.get(alertKey);

      if (!existing) {
        const alert: CongestionAlert = {
          routeId,
          severity: check.severity,
          metric: check.metric,
          currentValue: check.currentValue,
          threshold: check.threshold,
          message: check.message(check.currentValue, check.threshold),
          timestamp: new Date(),
        };

        this.activeAlerts.set(alertKey, alert);
        status.alertHistory.push(alert);
        this.emitAlert(alert);
      } else {
        existing.currentValue = check.currentValue;
      }
    }

    const resolvedAlerts: string[] = [];
    for (const [key, alert] of this.activeAlerts.entries()) {
      if (alert.routeId !== routeId) {
        continue;
      }

      const check = thresholdChecks.find(c => c.metric === alert.metric);
      if (!check || !check.exceeds) {
        alert.resolvedAt = new Date();
        resolvedAlerts.push(key);
      }
    }

    for (const key of resolvedAlerts) {
      this.activeAlerts.delete(key);
    }
  }

  private getLatencySeverity(value: number, threshold: number): CongestionAlert['severity'] {
    const ratio = value / threshold;
    if (ratio >= 3) return 'critical';
    if (ratio >= 2) return 'high';
    if (ratio >= 1.5) return 'medium';
    return 'low';
  }

  private getRateSeverity(value: number, threshold: number): CongestionAlert['severity'] {
    const ratio = value / threshold;
    if (ratio >= 2) return 'critical';
    if (ratio >= 1.5) return 'high';
    if (ratio >= 1.2) return 'medium';
    return 'low';
  }

  private getValueSeverity(value: number, threshold: number): CongestionAlert['severity'] {
    const ratio = value / threshold;
    if (ratio >= 5) return 'critical';
    if (ratio >= 3) return 'high';
    if (ratio >= 2) return 'medium';
    return 'low';
  }

  private getThroughputSeverity(value: number, threshold: number): CongestionAlert['severity'] {
    const ratio = threshold / value;
    if (ratio >= 5) return 'critical';
    if (ratio >= 3) return 'high';
    if (ratio >= 2) return 'medium';
    return 'low';
  }

  private emitAlert(alert: CongestionAlert): void {
    this.emit('alert', alert);
    if (this.config.onAlert) {
      this.config.onAlert(alert);
    }
  }

  private emitStatusChange(status: CongestionStatus): void {
    this.emit('status-change', status);
    if (this.config.onStatusChange) {
      this.config.onStatusChange(status);
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timeout);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }
}
