export interface RouteLatencyMetrics {
  routeId: string;
  averageLatencyMs: number;
  sampleCount: number;
}

export interface RouteSuccessMetrics {
  routeId: string;
  successRate: number; // 0–1
  totalExecutions: number;
}

export interface RoutePerformanceScore {
  routeId: string;
  /** Composite performance score 0–1, higher is better */
  score: number;
  latencyMetrics: RouteLatencyMetrics;
  successMetrics: RouteSuccessMetrics;
}

export interface StellarRoutePerformanceIndexOptions {
  /** Weight for success rate (0–1). Default 0.6 */
  successWeight?: number;
  /** Weight for latency (0–1). Default 0.4 */
  latencyWeight?: number;
  /** Maximum latency (ms) used for normalization. Default 10_000 */
  maxLatencyMs?: number;
}
