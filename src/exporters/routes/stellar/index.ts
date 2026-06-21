/**
 * Stellar Route Insights Exporter (#542).
 *
 * Aggregates per-route analytics and recommendation insights for Stellar
 * cross-chain bridging and serialises them into common export formats:
 * JSON, CSV, and Prometheus text exposition.
 *
 * The exporter is stateless with respect to transport -- callers register
 * route snapshots and recommendation results, then pull exports on demand.
 */

export type ExportFormat = 'json' | 'csv' | 'prometheus';

export interface RouteMetric {
  routeId: string;
  sourceChain: string;
  destinationChain: string;
  providerName: string;
  asset: string;
  feeUsd: number;
  estimatedTimeSeconds: number;
  reliabilityScore: number;
  liquidityUsd: number;
  slippagePercent: number;
  successRate: number;
  recordedAt: Date;
}

export interface RecommendationInsight {
  routeId: string;
  preference: 'fastest' | 'cheapest' | 'balanced' | 'most-reliable';
  score: number;
  rank: number;
  confidence: 'high' | 'medium' | 'low';
  costScore: number;
  speedScore: number;
  reliabilityScore: number;
  slippageScore: number;
  liquidityScore: number;
  recommendation: string;
  generatedAt: Date;
}

export interface RouteInsightsSnapshot {
  exportedAt: Date;
  totalRoutes: number;
  totalInsights: number;
  routes: RouteMetric[];
  insights: RecommendationInsight[];
}

export interface CsvExportOptions {
  delimiter?: string;
  includeHeader?: boolean;
  dataset?: 'routes' | 'insights' | 'both';
}

function escapeCsvField(value: string, delimiter: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');
  return needsQuoting ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value === null || value === undefined) return '';
  return String(value);
}

function prometheusLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) =>
      `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  );
  return parts.length ? `{${parts.join(',')}}` : '';
}

export class StellarRouteInsightsExporter {
  private readonly routes: RouteMetric[] = [];
  private readonly insights: RecommendationInsight[] = [];
  private readonly namespace: string;

  constructor(namespace = 'bridgewise_stellar_routes') {
    this.namespace = namespace;
  }

  registerRoute(metric: RouteMetric): void {
    const idx = this.routes.findIndex((r) => r.routeId === metric.routeId);
    if (idx >= 0) {
      this.routes[idx] = metric;
    } else {
      this.routes.push(metric);
    }
  }

  registerRoutes(metrics: RouteMetric[]): void {
    metrics.forEach((m) => this.registerRoute(m));
  }

  registerInsight(insight: RecommendationInsight): void {
    const idx = this.insights.findIndex(
      (i) => i.routeId === insight.routeId && i.preference === insight.preference,
    );
    if (idx >= 0) {
      this.insights[idx] = insight;
    } else {
      this.insights.push(insight);
    }
  }

  registerInsights(insights: RecommendationInsight[]): void {
    insights.forEach((i) => this.registerInsight(i));
  }

  clear(): void {
    this.routes.length = 0;
    this.insights.length = 0;
  }

  snapshot(): RouteInsightsSnapshot {
    return {
      exportedAt: new Date(),
      totalRoutes: this.routes.length,
      totalInsights: this.insights.length,
      routes: [...this.routes],
      insights: [...this.insights],
    };
  }

  toJSON(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  toJSONObject(): RouteInsightsSnapshot {
    return this.snapshot();
  }

  toCSV(options: CsvExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const includeHeader = options.includeHeader ?? true;
    const dataset = options.dataset ?? 'both';
    const sections: string[] = [];
    if (dataset === 'routes' || dataset === 'both') {
      sections.push(this.buildRoutesCSV(delimiter, includeHeader));
    }
    if (dataset === 'insights' || dataset === 'both') {
      if (dataset === 'both' && sections.length > 0) sections.push('');
      sections.push(this.buildInsightsCSV(delimiter, includeHeader));
    }
    return sections.join('\n');
  }

  private buildRoutesCSV(delimiter: string, includeHeader: boolean): string {
    const columns: Array<keyof RouteMetric> = [
      'routeId', 'sourceChain', 'destinationChain', 'providerName', 'asset',
      'feeUsd', 'estimatedTimeSeconds', 'reliabilityScore', 'liquidityUsd',
      'slippagePercent', 'successRate', 'recordedAt',
    ];
    const lines: string[] = [];
    if (includeHeader) {
      lines.push(columns.map((c) => escapeCsvField(c, delimiter)).join(delimiter));
    }
    for (const route of this.routes) {
      lines.push(columns.map((col) => escapeCsvField(formatValue(route[col]), delimiter)).join(delimiter));
    }
    return lines.join('\n');
  }

  private buildInsightsCSV(delimiter: string, includeHeader: boolean): string {
    const columns: Array<keyof RecommendationInsight> = [
      'routeId', 'preference', 'score', 'rank', 'confidence',
      'costScore', 'speedScore', 'reliabilityScore', 'slippageScore',
      'liquidityScore', 'recommendation', 'generatedAt',
    ];
    const lines: string[] = [];
    if (includeHeader) {
      lines.push(columns.map((c) => escapeCsvField(c, delimiter)).join(delimiter));
    }
    for (const insight of this.insights) {
      lines.push(columns.map((col) => escapeCsvField(formatValue(insight[col]), delimiter)).join(delimiter));
    }
    return lines.join('\n');
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const ns = this.namespace;

    const routeGauges: Array<{ name: string; help: string; field: keyof RouteMetric }> = [
      { name: 'fee_usd', help: 'Route fee in USD', field: 'feeUsd' },
      { name: 'estimated_time_seconds', help: 'Estimated bridge time in seconds', field: 'estimatedTimeSeconds' },
      { name: 'reliability_score', help: 'Route reliability score (0-100)', field: 'reliabilityScore' },
      { name: 'liquidity_usd', help: 'Available liquidity in USD', field: 'liquidityUsd' },
      { name: 'slippage_percent', help: 'Expected slippage percentage', field: 'slippagePercent' },
      { name: 'success_rate', help: 'Historical success rate (0-1)', field: 'successRate' },
    ];

    for (const def of routeGauges) {
      const fullName = `${ns}_${def.name}`;
      lines.push(`# HELP ${fullName} ${def.help}`);
      lines.push(`# TYPE ${fullName} gauge`);
      for (const route of this.routes) {
        const labels = prometheusLabels({
          route_id: route.routeId, source_chain: route.sourceChain,
          destination_chain: route.destinationChain, provider: route.providerName, asset: route.asset,
        });
        lines.push(`${fullName}${labels} ${route[def.field]}`);
      }
    }

    const insightGauges: Array<{ name: string; help: string; field: keyof RecommendationInsight }> = [
      { name: 'recommendation_score', help: 'Composite recommendation score (0-100)', field: 'score' },
      { name: 'recommendation_cost_score', help: 'Cost sub-score (0-100)', field: 'costScore' },
      { name: 'recommendation_speed_score', help: 'Speed sub-score (0-100)', field: 'speedScore' },
      { name: 'recommendation_reliability_score', help: 'Reliability sub-score (0-100)', field: 'reliabilityScore' },
      { name: 'recommendation_slippage_score', help: 'Slippage sub-score (0-100)', field: 'slippageScore' },
      { name: 'recommendation_liquidity_score', help: 'Liquidity sub-score (0-100)', field: 'liquidityScore' },
    ];

    for (const def of insightGauges) {
      const fullName = `${ns}_${def.name}`;
      lines.push(`# HELP ${fullName} ${def.help}`);
      lines.push(`# TYPE ${fullName} gauge`);
      for (const insight of this.insights) {
        const labels = prometheusLabels({
          route_id: insight.routeId, preference: insight.preference,
          confidence: insight.confidence, rank: String(insight.rank),
        });
        lines.push(`${fullName}${labels} ${insight[def.field]}`);
      }
    }

    const totalName = `${ns}_total_routes`;
    lines.push(`# HELP ${totalName} Total number of tracked Stellar routes`);
    lines.push(`# TYPE ${totalName} gauge`);
    lines.push(`${totalName} ${this.routes.length}`);

    const insightsName = `${ns}_total_insights`;
    lines.push(`# HELP ${insightsName} Total number of recommendation insights`);
    lines.push(`# TYPE ${insightsName} gauge`);
    lines.push(`${insightsName} ${this.insights.length}`);

    return lines.join('\n') + '\n';
  }

  export(format: ExportFormat, csvOptions?: CsvExportOptions): string {
    switch (format) {
      case 'json': return this.toJSON();
      case 'csv': return this.toCSV(csvOptions);
      case 'prometheus': return this.toPrometheus();
      default: throw new Error(`Unsupported export format: ${format as string}`);
    }
  }
}

/** Singleton instance for the common case where one exporter is shared app-wide. */
export const stellarRouteInsights = new StellarRouteInsightsExporter();