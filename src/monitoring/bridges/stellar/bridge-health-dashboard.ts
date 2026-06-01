export interface BridgeHealthMetric {
  providerId: string;
  uptimePercent: number;
  avgLatencyMs: number;
  lastCheckedAt: Date;
  healthy: boolean;
}

const metrics = new Map<string, BridgeHealthMetric>();

export function recordHealthCheck(
  providerId: string,
  latencyMs: number,
  success: boolean
): void {
  const existing = metrics.get(providerId);
  const prev = existing ?? { providerId, uptimePercent: 100, avgLatencyMs: 0, lastCheckedAt: new Date(), healthy: true };
  const newAvg = Math.round((prev.avgLatencyMs + latencyMs) / 2);
  const newUptime = success ? Math.min(100, prev.uptimePercent + 0.1) : Math.max(0, prev.uptimePercent - 5);
  metrics.set(providerId, {
    providerId,
    uptimePercent: parseFloat(newUptime.toFixed(2)),
    avgLatencyMs: newAvg,
    lastCheckedAt: new Date(),
    healthy: success,
  });
}

export function getProviderHealth(providerId: string): BridgeHealthMetric | undefined {
  return metrics.get(providerId);
}

export function getAllHealthMetrics(): BridgeHealthMetric[] {
  return Array.from(metrics.values());
}