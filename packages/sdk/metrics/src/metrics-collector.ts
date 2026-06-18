import { SdkTelemetryEvent } from './types';

/**
 * MetricsCollector — low-overhead in-process store for SDK telemetry events.
 *
 * Usage:
 *   const collector = MetricsCollector.getInstance();
 *   collector.record({ sdk: 'bridge-core', sdkVersion: '0.1.0', method: 'getQuote', ... });
 *
 * The collector is a singleton so all SDK packages share one buffer.
 * Call reset() between test runs to avoid cross-test pollution.
 */
export class MetricsCollector {
  private static instance: MetricsCollector;
  private events: SdkTelemetryEvent[] = [];
  private readonly maxBufferSize: number;

  private constructor(maxBufferSize = 10_000) {
    this.maxBufferSize = maxBufferSize;
  }

  static getInstance(maxBufferSize?: number): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector(maxBufferSize);
    }
    return MetricsCollector.instance;
  }

  /** Record a single telemetry event. Drops oldest event when buffer is full. */
  record(event: SdkTelemetryEvent): void {
    if (this.events.length >= this.maxBufferSize) {
      this.events.shift();
    }
    this.events.push({ ...event, timestamp: event.timestamp ?? Date.now() });
  }

  /**
   * Convenience wrapper: records a method call automatically.
   * Returns the result of fn; records success/failure and duration.
   */
  async track<T>(
    sdk: string,
    sdkVersion: string,
    method: string,
    fn: () => Promise<T>,
    meta?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.record({
        sdk,
        sdkVersion,
        method,
        timestamp: start,
        durationMs: Date.now() - start,
        success: true,
        meta,
        sessionId,
      });
      return result;
    } catch (err) {
      this.record({
        sdk,
        sdkVersion,
        method,
        timestamp: start,
        durationMs: Date.now() - start,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        meta,
        sessionId,
      });
      throw err;
    }
  }

  /** Return a copy of all buffered events, optionally filtered. */
  getEvents(filter?: Partial<Pick<SdkTelemetryEvent, 'sdk' | 'method'>>): SdkTelemetryEvent[] {
    if (!filter) return [...this.events];
    return this.events.filter((e) => {
      if (filter.sdk && e.sdk !== filter.sdk) return false;
      if (filter.method && e.method !== filter.method) return false;
      return true;
    });
  }

  /** Total number of buffered events. */
  get size(): number {
    return this.events.length;
  }

  /** Clear the buffer (useful in tests). */
  reset(): void {
    this.events = [];
  }
}
