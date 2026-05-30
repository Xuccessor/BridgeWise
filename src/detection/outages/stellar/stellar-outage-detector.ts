import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import axios, { AxiosError } from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EndpointStatus = 'operational' | 'degraded' | 'outage';
export type EndpointType = 'horizon' | 'soroban-rpc';
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface EndpointConfig {
  name: string;
  url: string;
  type: EndpointType;
  isDefault?: boolean;
  /** Weight used for load balancing among healthy endpoints (default: 1) */
  weight?: number;
  /** Tags for grouping (e.g. 'mainnet', 'testnet', 'eu') */
  tags?: string[];
}

export interface HealthCheckEntry {
  timestamp: Date;
  status: EndpointStatus;
  responseTimeMs: number;
  ledgerSequence?: number;
  errorMessage?: string;
}

export interface CircuitBreakerState {
  state: CircuitState;
  openedAt?: Date;
  halfOpenAt?: Date;
  /** How long the circuit stays open before moving to half-open (ms) */
  cooldownMs: number;
}

export interface EndpointState {
  config: EndpointConfig;
  status: EndpointStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheckTime?: number;
  responseTimeMs?: number;
  lastLedgerSequence?: number;
  lastLedgerCloseTime?: number;
  lastErrorMessage?: string;
  circuit: CircuitBreakerState;
  /** Rolling window of recent health checks */
  history: HealthCheckEntry[];
  /** Uptime percentage over the history window */
  uptimePct: number;
  /** Average response time over the history window */
  avgResponseTimeMs: number;
}

export interface StellarOutageDetectorConfig {
  checkIntervalMs?: number;
  timeoutMs?: number;
  unhealthyThreshold?: number;
  degradedResponseTimeMs?: number;
  maxLedgerAgeMs?: number;
  /** Max health check history entries per endpoint (default: 100) */
  maxHistoryEntries?: number;
  /** How many consecutive successes needed to close a circuit (default: 2) */
  circuitRecoveryThreshold?: number;
  /** How long circuit stays open before going half-open in ms (default: 60000) */
  circuitCooldownMs?: number;
  /** Max retry attempts on transient failures (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in ms, doubles each attempt (default: 500) */
  retryBaseDelayMs?: number;
  /** If true, checks run in parallel instead of sequentially (default: true) */
  parallelChecks?: boolean;
}

export interface OutageAlert {
  providerName: string;
  providerUrl: string;
  providerType: EndpointType;
  previousStatus: EndpointStatus;
  currentStatus: EndpointStatus;
  reason?: string;
  responseTimeMs?: number;
  lastLedgerSequence?: number;
  lastLedgerCloseTime?: string;
  errorMessage?: string;
  consecutiveFailures: number;
  uptimePct: number;
  timestamp: Date;
}

export interface EndpointMetrics {
  url: string;
  name: string;
  type: EndpointType;
  status: EndpointStatus;
  circuitState: CircuitState;
  uptimePct: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  totalChecks: number;
  consecutiveFailures: number;
  lastLedgerSequence?: number;
  lastCheckTime?: number;
}

// ─── Event map for type-safe listeners ───────────────────────────────────────

export interface OutageDetectorEventMap {
  outage: OutageAlert;
  degraded: OutageAlert;
  recovered: OutageAlert;
  'status-change': OutageAlert;
  'circuit-open': { url: string; name: string };
  'circuit-half-open': { url: string; name: string };
  'circuit-closed': { url: string; name: string };
  'failover': { from: string; to: string; type: EndpointType };
}

// ─── Detector ─────────────────────────────────────────────────────────────────

@Injectable()
export class StellarOutageDetector extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(StellarOutageDetector.name);
  private readonly cfg: Required<StellarOutageDetectorConfig>;
  private readonly endpoints: Map<string, EndpointState> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: StellarOutageDetectorConfig = {}) {
    super();
    this.cfg = {
      checkIntervalMs: config.checkIntervalMs ?? 30_000,
      timeoutMs: config.timeoutMs ?? 5_000,
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      degradedResponseTimeMs: config.degradedResponseTimeMs ?? 2_000,
      maxLedgerAgeMs: config.maxLedgerAgeMs ?? 60_000,
      maxHistoryEntries: config.maxHistoryEntries ?? 100,
      circuitRecoveryThreshold: config.circuitRecoveryThreshold ?? 2,
      circuitCooldownMs: config.circuitCooldownMs ?? 60_000,
      maxRetries: config.maxRetries ?? 2,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 500,
      parallelChecks: config.parallelChecks ?? true,
    };
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  registerHorizonEndpoint(name: string, url: string, isDefault = false, options: Partial<Pick<EndpointConfig, 'weight' | 'tags'>> = {}): void {
    this.register({ name, url, type: 'horizon', isDefault, ...options });
  }

  registerSorobanRpcEndpoint(name: string, url: string, isDefault = false, options: Partial<Pick<EndpointConfig, 'weight' | 'tags'>> = {}): void {
    this.register({ name, url, type: 'soroban-rpc', isDefault, ...options });
  }

  private register(config: EndpointConfig): void {
    const url = normalizeUrl(config.url);
    if (this.endpoints.has(url)) {
      this.logger.warn(`Endpoint already registered, skipping: ${url}`);
      return;
    }
    this.endpoints.set(url, {
      config: { ...config, url },
      status: 'operational',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      circuit: { state: 'closed', cooldownMs: this.cfg.circuitCooldownMs },
      history: [],
      uptimePct: 100,
      avgResponseTimeMs: 0,
    });
    this.logger.log(`Registered ${config.type} endpoint: ${config.name} (${url})`);
  }

  unregisterEndpoint(url: string): boolean {
    const removed = this.endpoints.delete(normalizeUrl(url));
    if (removed) this.logger.log(`Unregistered endpoint: ${url}`);
    return removed;
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getStates(): EndpointState[] {
    return [...this.endpoints.values()];
  }

  getState(url: string): EndpointState | undefined {
    return this.endpoints.get(normalizeUrl(url));
  }

  /**
   * Returns all endpoints of a given type that are currently healthy,
   * sorted by weight * inverse-latency score — useful for routing decisions.
   */
  getHealthyEndpoints(type: EndpointType, tags?: string[]): EndpointState[] {
    return [...this.endpoints.values()]
      .filter((s) => {
        const typeMatch = s.config.type === type;
        const statusOk = s.status !== 'outage' && s.circuit.state !== 'open';
        const tagMatch = !tags?.length || tags.every((t) => s.config.tags?.includes(t));
        return typeMatch && statusOk && tagMatch;
      })
      .sort((a, b) => {
        const scoreA = (a.config.weight ?? 1) / Math.max(1, a.avgResponseTimeMs);
        const scoreB = (b.config.weight ?? 1) / Math.max(1, b.avgResponseTimeMs);
        return scoreB - scoreA;
      });
  }

  /**
   * Returns the single best endpoint of a type — the top of getHealthyEndpoints.
   * Emits a 'failover' event if the current default is not the best choice.
   */
  getBestEndpoint(type: EndpointType, tags?: string[]): EndpointState | null {
    const healthy = this.getHealthyEndpoints(type, tags);
    if (!healthy.length) return null;

    const best = healthy[0];
    const defaultEp = [...this.endpoints.values()].find(
      (s) => s.config.type === type && s.config.isDefault
    );

    if (defaultEp && defaultEp.config.url !== best.config.url) {
      this.safeEmit('failover', {
        from: defaultEp.config.url,
        to: best.config.url,
        type,
      });
    }

    return best;
  }

  /**
   * Per-endpoint metrics snapshot — suitable for Prometheus/Grafana scraping.
   */
  getMetrics(): EndpointMetrics[] {
    return [...this.endpoints.values()].map((s) => ({
      url: s.config.url,
      name: s.config.name,
      type: s.config.type,
      status: s.status,
      circuitState: s.circuit.state,
      uptimePct: s.uptimePct,
      avgResponseTimeMs: s.avgResponseTimeMs,
      p95ResponseTimeMs: percentile(s.history.map((h) => h.responseTimeMs), 95),
      totalChecks: s.history.length,
      consecutiveFailures: s.consecutiveFailures,
      lastLedgerSequence: s.lastLedgerSequence,
      lastCheckTime: s.lastCheckTime,
    }));
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  async checkHorizonEndpoint(url: string): Promise<EndpointState> {
    const state = this.getState(url);
    if (!state || state.config.type !== 'horizon') {
      throw new Error(`Horizon endpoint not registered: ${url}`);
    }

    if (this.isCircuitOpen(state)) {
      this.logger.warn(`Circuit open — skipping check for ${state.config.name}`);
      return state;
    }

    const check = () =>
      axios.get(state.config.url, {
        timeout: this.cfg.timeoutMs,
        headers: { Accept: 'application/json' },
      });

    const startTime = Date.now();
    try {
      const response = await withRetry(check, this.cfg.maxRetries, this.cfg.retryBaseDelayMs);
      const responseTime = Date.now() - startTime;
      const data = response.data;

      const latestLedger = data.history_latest_ledger ?? data.core_latest_ledger;
      const closedAtStr = data.history_latest_ledger_closed_at;

      if (!latestLedger || !closedAtStr) {
        throw new Error('Invalid Horizon response: missing ledger metadata');
      }

      const closedAt = new Date(closedAtStr);
      const ledgerAgeMs = Date.now() - closedAt.getTime();

      if (ledgerAgeMs > this.cfg.maxLedgerAgeMs) {
        this.handleFailure(state, `Ledger stalled — age: ${Math.round(ledgerAgeMs / 1000)}s`, responseTime, 'LEDGER_STALLED', latestLedger, closedAt.getTime());
      } else {
        this.handleSuccess(state, responseTime, latestLedger, closedAt.getTime());
      }
    } catch (error) {
      this.handleFailure(state, formatError(error), Date.now() - startTime, classifyReason(error));
    }

    return state;
  }

  async checkSorobanRpcEndpoint(url: string): Promise<EndpointState> {
    const state = this.getState(url);
    if (!state || state.config.type !== 'soroban-rpc') {
      throw new Error(`Soroban RPC endpoint not registered: ${url}`);
    }

    if (this.isCircuitOpen(state)) {
      this.logger.warn(`Circuit open — skipping check for ${state.config.name}`);
      return state;
    }

    const check = () =>
      axios.post(
        state.config.url,
        { jsonrpc: '2.0', id: 1, method: 'getLatestLedger' },
        { timeout: this.cfg.timeoutMs, headers: { 'Content-Type': 'application/json' } }
      );

    const startTime = Date.now();
    try {
      const response = await withRetry(check, this.cfg.maxRetries, this.cfg.retryBaseDelayMs);
      const responseTime = Date.now() - startTime;
      const data = response.data;

      if (data.error) {
        throw new Error(`JSON-RPC error: ${data.error.message ?? JSON.stringify(data.error)}`);
      }

      const result = data.result;
      if (!result || typeof result.sequence !== 'number' || typeof result.closeTimestamp !== 'number') {
        throw new Error('Invalid Soroban RPC response: missing sequence or closeTimestamp');
      }

      const closedAtMs = result.closeTimestamp * 1000;
      const ledgerAgeMs = Date.now() - closedAtMs;

      if (ledgerAgeMs > this.cfg.maxLedgerAgeMs) {
        this.handleFailure(state, `Ledger stalled — age: ${Math.round(ledgerAgeMs / 1000)}s`, responseTime, 'LEDGER_STALLED', result.sequence, closedAtMs);
      } else {
        this.handleSuccess(state, responseTime, result.sequence, closedAtMs);
      }
    } catch (error) {
      this.handleFailure(state, formatError(error), Date.now() - startTime, classifyReason(error));
    }

    return state;
  }

  async checkAll(): Promise<Map<string, EndpointState>> {
    const entries = [...this.endpoints.entries()];
    const checkFn = ([url, state]: [string, EndpointState]) =>
      state.config.type === 'horizon'
        ? this.checkHorizonEndpoint(url)
        : this.checkSorobanRpcEndpoint(url);

    if (this.cfg.parallelChecks) {
      await Promise.allSettled(entries.map(checkFn));
    } else {
      for (const entry of entries) await checkFn(entry).catch(() => {});
    }

    return new Map(entries.map(([url]) => [url, this.endpoints.get(url)!]));
  }

  // ─── Monitoring lifecycle ─────────────────────────────────────────────────

  startMonitoring(): void {
    if (this.checkInterval) return;

    this.logger.log(`Starting monitoring — interval: ${this.cfg.checkIntervalMs}ms, parallel: ${this.cfg.parallelChecks}`);

    this.checkInterval = setInterval(async () => {
      try {
        await this.checkAll();
      } catch (err: any) {
        this.logger.error('Periodic check error:', err.message);
      }
    }, this.cfg.checkIntervalMs);

    this.checkAll().catch((err: any) =>
      this.logger.error('Initial check failed:', err.message)
    );
  }

  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.log('Monitoring stopped');
    }
  }

  /** NestJS lifecycle hook — stops monitoring when module is destroyed */
  onModuleDestroy(): void {
    this.stopMonitoring();
  }

  // ─── Circuit Breaker ───────────────────────────────────────────────────────

  private isCircuitOpen(state: EndpointState): boolean {
    const { circuit } = state;

    if (circuit.state === 'closed') return false;

    if (circuit.state === 'open') {
      const elapsed = Date.now() - (circuit.openedAt?.getTime() ?? 0);
      if (elapsed >= circuit.cooldownMs) {
        circuit.state = 'half-open';
        circuit.halfOpenAt = new Date();
        this.logger.log(`Circuit half-open for ${state.config.name}`);
        this.safeEmit('circuit-half-open', { url: state.config.url, name: state.config.name });
        return false; // allow one probe
      }
      return true; // still cooling down
    }

    return false; // half-open: allow probe
  }

  private openCircuit(state: EndpointState): void {
    if (state.circuit.state === 'open') return;
    state.circuit.state = 'open';
    state.circuit.openedAt = new Date();
    this.logger.error(`Circuit OPENED for ${state.config.name}`);
    this.safeEmit('circuit-open', { url: state.config.url, name: state.config.name });
  }

  private closeCircuit(state: EndpointState): void {
    if (state.circuit.state === 'closed') return;
    state.circuit.state = 'closed';
    state.circuit.openedAt = undefined;
    state.circuit.halfOpenAt = undefined;
    this.logger.log(`Circuit CLOSED for ${state.config.name}`);
    this.safeEmit('circuit-closed', { url: state.config.url, name: state.config.name });
  }

  // ─── Success / Failure handlers ────────────────────────────────────────────

  private handleSuccess(
    state: EndpointState,
    responseTimeMs: number,
    ledgerSequence: number,
    ledgerCloseTimeMs: number
  ): void {
    const prevStatus = state.status;

    state.consecutiveFailures = 0;
    state.consecutiveSuccesses++;
    state.lastCheckTime = Date.now();
    state.responseTimeMs = responseTimeMs;
    state.lastLedgerSequence = ledgerSequence;
    state.lastLedgerCloseTime = ledgerCloseTimeMs;
    delete state.lastErrorMessage;

    // Close circuit after enough consecutive successes
    if (
      state.circuit.state === 'half-open' &&
      state.consecutiveSuccesses >= this.cfg.circuitRecoveryThreshold
    ) {
      this.closeCircuit(state);
    }

    const nextStatus: EndpointStatus =
      responseTimeMs > this.cfg.degradedResponseTimeMs ? 'degraded' : 'operational';

    state.status = nextStatus;
    this.pushHistory(state, nextStatus, responseTimeMs, ledgerSequence);

    if (prevStatus !== nextStatus) {
      this.emitAlert(state, prevStatus, nextStatus, nextStatus === 'degraded' ? 'HIGH_LATENCY' : undefined);
    }
  }

  private handleFailure(
    state: EndpointState,
    errorMessage: string,
    responseTimeMs: number,
    reason: string,
    ledgerSequence?: number,
    ledgerCloseTimeMs?: number
  ): void {
    const prevStatus = state.status;

    state.consecutiveFailures++;
    state.consecutiveSuccesses = 0;
    state.lastCheckTime = Date.now();
    state.responseTimeMs = responseTimeMs;
    state.lastErrorMessage = errorMessage;

    if (ledgerSequence !== undefined) state.lastLedgerSequence = ledgerSequence;
    if (ledgerCloseTimeMs !== undefined) state.lastLedgerCloseTime = ledgerCloseTimeMs;

    this.pushHistory(state, 'outage', responseTimeMs, ledgerSequence, errorMessage);

    let nextStatus: EndpointStatus = state.status;

    if (state.consecutiveFailures >= this.cfg.unhealthyThreshold) {
      nextStatus = 'outage';
      this.openCircuit(state);
    } else if (prevStatus === 'operational') {
      nextStatus = 'degraded';
    }

    state.status = nextStatus;

    if (prevStatus !== nextStatus) {
      this.emitAlert(state, prevStatus, nextStatus, reason);
    } else {
      this.logger.warn(
        `[${state.config.name}] Check failed (${state.consecutiveFailures}/${this.cfg.unhealthyThreshold}): ${errorMessage}`
      );
    }
  }

  // ─── History & Metrics ─────────────────────────────────────────────────────

  private pushHistory(
    state: EndpointState,
    status: EndpointStatus,
    responseTimeMs: number,
    ledgerSequence?: number,
    errorMessage?: string
  ): void {
    state.history.push({ timestamp: new Date(), status, responseTimeMs, ledgerSequence, errorMessage });

    if (state.history.length > this.cfg.maxHistoryEntries) {
      state.history.shift();
    }

    const times = state.history.map((h) => h.responseTimeMs);
    state.avgResponseTimeMs = times.reduce((a, b) => a + b, 0) / times.length;

    const operational = state.history.filter((h) => h.status !== 'outage').length;
    state.uptimePct = Math.round((operational / state.history.length) * 100 * 100) / 100;
  }

  // ─── Alert emission ────────────────────────────────────────────────────────

  private emitAlert(
    state: EndpointState,
    previousStatus: EndpointStatus,
    currentStatus: EndpointStatus,
    reason?: string
  ): void {
    const alert: OutageAlert = {
      providerName: state.config.name,
      providerUrl: state.config.url,
      providerType: state.config.type,
      previousStatus,
      currentStatus,
      reason: reason ?? (currentStatus === 'outage' ? 'UNAVAILABLE' : undefined),
      responseTimeMs: state.responseTimeMs,
      lastLedgerSequence: state.lastLedgerSequence,
      lastLedgerCloseTime: state.lastLedgerCloseTime
        ? new Date(state.lastLedgerCloseTime).toISOString()
        : undefined,
      errorMessage: state.lastErrorMessage,
      consecutiveFailures: state.consecutiveFailures,
      uptimePct: state.uptimePct,
      timestamp: new Date(),
    };

    const msg = `[${alert.providerName}] ${previousStatus.toUpperCase()} → ${currentStatus.toUpperCase()}${reason ? ` (${reason})` : ''}`;

    if (currentStatus === 'outage') {
      this.logger.error(msg);
      this.safeEmit('outage', alert);
    } else if (currentStatus === 'degraded') {
      this.logger.warn(msg);
      this.safeEmit('degraded', alert);
    } else {
      this.logger.log(msg);
      this.safeEmit('recovered', alert);
    }

    this.safeEmit('status-change', alert);
  }

  private safeEmit<K extends keyof OutageDetectorEventMap>(event: K, payload: OutageDetectorEventMap[K]): void {
    try {
      this.emit(event, payload);
    } catch (err: any) {
      this.logger.error(`Event listener error on "${event}":`, err.message);
    }
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function formatError(error: any): string {
  if (error?.response) {
    return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
  }
  if (error?.request) return `No response: ${error.message}`;
  return error?.message ?? String(error);
}

function classifyReason(error: any): string {
  if (axios.isCancel(error)) return 'CANCELLED';
  if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) return 'TIMEOUT';
  if (error?.response) return 'HTTP_ERROR';
  return 'NETWORK_ERROR';
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // Don't retry on HTTP 4xx client errors — they won't resolve themselves
      if (err?.response?.status >= 400 && err?.response?.status < 500) throw err;
      if (attempt < maxRetries) {
        await delay(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const stellarOutageDetector = new StellarOutageDetector();