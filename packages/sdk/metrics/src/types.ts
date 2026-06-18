/**
 * Core types for the BridgeWise SDK Metrics Collector.
 * Mirrors the AnalyticsEvent shape from @bridgewise/bridge-core
 * so the collector can ingest events without a hard dependency.
 */

export type SdkName = string;
export type SdkVersion = string;

/** A single telemetry event recorded by an SDK call site. */
export interface SdkTelemetryEvent {
  /** Which SDK package emitted the event (e.g. "bridge-core", "ui", "utils"). */
  sdk: SdkName;
  sdkVersion: SdkVersion;
  /** Method or operation name (e.g. "getQuote", "executeTransfer"). */
  method: string;
  /** Unix timestamp (ms) when the call was initiated. */
  timestamp: number;
  /** Wall-clock duration of the call in ms. */
  durationMs: number;
  /** Whether the call completed successfully. */
  success: boolean;
  /** Error message if success === false. */
  error?: string;
  /** Anonymized session identifier. */
  sessionId?: string;
  /** Free-form metadata (chain names, bridge names, etc.). */
  meta?: Record<string, unknown>;
}

/** Per-method aggregated statistics. */
export interface MethodStats {
  method: string;
  callCount: number;
  successCount: number;
  errorCount: number;
  successRate: number;     // 0–1
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

/** Per-SDK aggregated statistics. */
export interface SdkStats {
  sdk: SdkName;
  sdkVersion: SdkVersion;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  uniqueSessions: number;
  methods: MethodStats[];
}

/** Adoption report produced by the reporter. */
export interface SdkAdoptionReport {
  generatedAt: string;          // ISO-8601
  periodStart: string;
  periodEnd: string;
  totalEvents: number;
  totalSdks: number;
  totalUniqueSessions: number;
  sdks: SdkStats[];
  /** Top 5 most-called methods across all SDKs. */
  topMethods: MethodStats[];
  /** Overall error rate across all SDKs. */
  overallErrorRate: number;
}
