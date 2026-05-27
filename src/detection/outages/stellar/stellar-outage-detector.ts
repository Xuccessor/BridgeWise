import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import axios, { AxiosError } from 'axios';

export type EndpointStatus = 'operational' | 'degraded' | 'outage';
export type EndpointType = 'horizon' | 'soroban-rpc';

export interface EndpointConfig {
  name: string;
  url: string;
  type: EndpointType;
  isDefault?: boolean;
}

export interface EndpointState {
  config: EndpointConfig;
  status: EndpointStatus;
  consecutiveFailures: number;
  lastCheckTime?: number;
  responseTimeMs?: number;
  lastLedgerSequence?: number;
  lastLedgerCloseTime?: number;
  lastErrorMessage?: string;
}

export interface StellarOutageDetectorConfig {
  checkIntervalMs?: number;        // Interval between periodic checks (default: 30000ms)
  timeoutMs?: number;              // Request timeout (default: 5000ms)
  unhealthyThreshold?: number;     // Failures before outage status (default: 3)
  degradedResponseTimeMs?: number; // Response time threshold for degraded status (default: 2000ms)
  maxLedgerAgeMs?: number;          // Maximum age of the latest ledger before marking outage (default: 60000ms)
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
  timestamp: Date;
}

@Injectable()
export class StellarOutageDetector extends EventEmitter {
  private readonly logger = new Logger(StellarOutageDetector.name);
  private readonly config: Required<StellarOutageDetectorConfig>;
  private readonly endpoints: Map<string, EndpointState> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: StellarOutageDetectorConfig = {}) {
    super();
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 30000,
      timeoutMs: config.timeoutMs ?? 5000,
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      degradedResponseTimeMs: config.degradedResponseTimeMs ?? 2000,
      maxLedgerAgeMs: config.maxLedgerAgeMs ?? 60000,
    };
  }

  /**
   * Register a Horizon endpoint to monitor
   */
  registerHorizonEndpoint(name: string, url: string, isDefault = false): void {
    const cleanUrl = url.replace(/\/$/, '');
    this.endpoints.set(cleanUrl, {
      config: { name, url: cleanUrl, type: 'horizon', isDefault },
      status: 'operational',
      consecutiveFailures: 0,
    });
    this.logger.log(`Registered Horizon endpoint for monitoring: ${name} (${cleanUrl})`);
  }

  /**
   * Register a Soroban RPC endpoint to monitor
   */
  registerSorobanRpcEndpoint(name: string, url: string, isDefault = false): void {
    const cleanUrl = url.replace(/\/$/, '');
    this.endpoints.set(cleanUrl, {
      config: { name, url: cleanUrl, type: 'soroban-rpc', isDefault },
      status: 'operational',
      consecutiveFailures: 0,
    });
    this.logger.log(`Registered Soroban RPC endpoint for monitoring: ${name} (${cleanUrl})`);
  }

  /**
   * Unregister an endpoint
   */
  unregisterEndpoint(url: string): boolean {
    const cleanUrl = url.replace(/\/$/, '');
    const removed = this.endpoints.delete(cleanUrl);
    if (removed) {
      this.logger.log(`Unregistered endpoint: ${cleanUrl}`);
    }
    return removed;
  }

  /**
   * Get states of all registered endpoints
   */
  getStates(): EndpointState[] {
    return Array.from(this.endpoints.values());
  }

  /**
   * Get specific endpoint state
   */
  getState(url: string): EndpointState | undefined {
    const cleanUrl = url.replace(/\/$/, '');
    return this.endpoints.get(cleanUrl);
  }

  /**
   * Check a specific Horizon endpoint availability
   */
  async checkHorizonEndpoint(url: string): Promise<EndpointState> {
    const state = this.getState(url);
    if (!state || state.config.type !== 'horizon') {
      throw new Error(`Horizon endpoint not registered: ${url}`);
    }

    const startTime = Date.now();
    try {
      const response = await axios.get(state.config.url, {
        timeout: this.config.timeoutMs,
        headers: { 'Accept': 'application/json' },
      });

      const responseTime = Date.now() - startTime;
      const data = response.data;

      // Extract ledger stats
      const latestLedger = data.history_latest_ledger ?? data.core_latest_ledger;
      const closedAtStr = data.history_latest_ledger_closed_at;

      if (!latestLedger || !closedAtStr) {
        throw new Error('Invalid Horizon response: Missing ledger metadata');
      }

      const closedAt = new Date(closedAtStr);
      const ledgerAgeMs = Date.now() - closedAt.getTime();

      // Check for ledger stagnation
      if (ledgerAgeMs > this.config.maxLedgerAgeMs) {
        const errorMsg = `Stellar ledger stalled. Age: ${Math.round(ledgerAgeMs / 1000)}s, max: ${this.config.maxLedgerAgeMs / 1000}s`;
        this.handleCheckFailure(state, errorMsg, responseTime, 'LEDGER_STALLED', latestLedger, closedAt.getTime());
      } else {
        this.handleCheckSuccess(state, responseTime, latestLedger, closedAt.getTime());
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMsg = this.formatErrorMessage(error);
      const reason = this.classifyErrorReason(error);
      this.handleCheckFailure(state, errorMsg, responseTime, reason);
    }

    return state;
  }

  /**
   * Check a specific Soroban RPC endpoint availability
   */
  async checkSorobanRpcEndpoint(url: string): Promise<EndpointState> {
    const state = this.getState(url);
    if (!state || state.config.type !== 'soroban-rpc') {
      throw new Error(`Soroban RPC endpoint not registered: ${url}`);
    }

    const startTime = Date.now();
    try {
      const response = await axios.post(
        state.config.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestLedger',
        },
        {
          timeout: this.config.timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        }
      );

      const responseTime = Date.now() - startTime;
      const data = response.data;

      if (data.error) {
        throw new Error(`JSON-RPC error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      const result = data.result;
      if (!result || typeof result.sequence !== 'number' || typeof result.closeTimestamp !== 'number') {
        throw new Error('Invalid Soroban RPC response: Missing sequence or closeTimestamp');
      }

      const closedAtMs = result.closeTimestamp * 1000;
      const ledgerAgeMs = Date.now() - closedAtMs;

      // Check for ledger stagnation
      if (ledgerAgeMs > this.config.maxLedgerAgeMs) {
        const errorMsg = `Stellar ledger stalled. Age: ${Math.round(ledgerAgeMs / 1000)}s, max: ${this.config.maxLedgerAgeMs / 1000}s`;
        this.handleCheckFailure(state, errorMsg, responseTime, 'LEDGER_STALLED', result.sequence, closedAtMs);
      } else {
        this.handleCheckSuccess(state, responseTime, result.sequence, closedAtMs);
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMsg = this.formatErrorMessage(error);
      const reason = this.classifyErrorReason(error);
      this.handleCheckFailure(state, errorMsg, responseTime, reason);
    }

    return state;
  }

  /**
   * Run availability checks on all registered endpoints
   */
  async checkAll(): Promise<Map<string, EndpointState>> {
    const results = new Map<string, EndpointState>();

    for (const [url, state] of this.endpoints) {
      let updatedState: EndpointState;
      if (state.config.type === 'horizon') {
        updatedState = await this.checkHorizonEndpoint(url);
      } else {
        updatedState = await this.checkSorobanRpcEndpoint(url);
      }
      results.set(url, updatedState);
    }

    return results;
  }

  /**
   * Start background monitoring
   */
  startMonitoring(): void {
    if (this.checkInterval) {
      return;
    }

    this.logger.log(`Starting periodic Stellar provider monitoring (interval: ${this.config.checkIntervalMs}ms)`);
    this.checkInterval = setInterval(async () => {
      try {
        await this.checkAll();
      } catch (error) {
        this.logger.error('Error during periodic outage check:', error.message);
      }
    }, this.config.checkIntervalMs);

    // Initial check run asynchronously
    this.checkAll().catch((err) =>
      this.logger.error('Initial startup outage check failed:', err.message)
    );
  }

  /**
   * Stop background monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.logger.log('Stopped periodic Stellar provider monitoring');
    }
  }

  /**
   * Handle check success
   */
  private handleCheckSuccess(
    state: EndpointState,
    responseTimeMs: number,
    ledgerSequence: number,
    ledgerCloseTimeMs: number
  ): void {
    const prevStatus = state.status;
    state.consecutiveFailures = 0;
    state.lastCheckTime = Date.now();
    state.responseTimeMs = responseTimeMs;
    state.lastLedgerSequence = ledgerSequence;
    state.lastLedgerCloseTime = ledgerCloseTimeMs;
    delete state.lastErrorMessage;

    // Determine status
    let nextStatus: EndpointStatus = 'operational';
    let reason: string | undefined;

    if (responseTimeMs > this.config.degradedResponseTimeMs) {
      nextStatus = 'degraded';
      reason = 'HIGH_LATENCY';
    }

    state.status = nextStatus;

    if (prevStatus !== nextStatus) {
      this.emitAlert(state, prevStatus, nextStatus, reason);
    }
  }

  /**
   * Handle check failure
   */
  private handleCheckFailure(
    state: EndpointState,
    errorMessage: string,
    responseTimeMs: number,
    reason: string,
    ledgerSequence?: number,
    ledgerCloseTimeMs?: number
  ): void {
    const prevStatus = state.status;
    state.consecutiveFailures++;
    state.lastCheckTime = Date.now();
    state.responseTimeMs = responseTimeMs;
    state.lastErrorMessage = errorMessage;

    if (ledgerSequence !== undefined) {
      state.lastLedgerSequence = ledgerSequence;
    }
    if (ledgerCloseTimeMs !== undefined) {
      state.lastLedgerCloseTime = ledgerCloseTimeMs;
    }

    let nextStatus: EndpointStatus = state.status;

    if (state.consecutiveFailures >= this.config.unhealthyThreshold) {
      nextStatus = 'outage';
    } else if (prevStatus === 'operational') {
      // Degraded on single failures before threshold is hit
      nextStatus = 'degraded';
    }

    state.status = nextStatus;

    if (prevStatus !== nextStatus) {
      this.emitAlert(state, prevStatus, nextStatus, reason);
    } else {
      this.logger.warn(
        `Check failed for ${state.config.name} (${state.config.url}) [Failures: ${state.consecutiveFailures}]: ${errorMessage}`
      );
    }
  }

  /**
   * Emit status transition alert
   */
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
      reason: reason || (currentStatus === 'outage' ? 'UNAVAILABLE' : undefined),
      responseTimeMs: state.responseTimeMs,
      lastLedgerSequence: state.lastLedgerSequence,
      lastLedgerCloseTime: state.lastLedgerCloseTime
        ? new Date(state.lastLedgerCloseTime).toISOString()
        : undefined,
      errorMessage: state.lastErrorMessage,
      timestamp: new Date(),
    };

    const statusMessage = `Provider ${alert.providerName} (${alert.providerUrl}) status changed: ${previousStatus.toUpperCase()} -> ${currentStatus.toUpperCase()}${reason ? ` (Reason: ${reason})` : ''}`;
    
    if (currentStatus === 'outage') {
      this.logger.error(statusMessage);
      this.emit('outage', alert);
    } else if (currentStatus === 'degraded') {
      this.logger.warn(statusMessage);
      this.emit('degraded', alert);
    } else {
      this.logger.log(statusMessage);
      this.emit('recovered', alert);
    }

    this.emit('status-change', alert);
  }

  /**
   * Format error to a readable string
   */
  private formatErrorMessage(error: any): string {
    if (error.response) {
      return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    }
    if (error.request) {
      return `No response received: ${error.message}`;
    }
    return error.message || String(error);
  }

  /**
   * Classify error type
   */
  private classifyErrorReason(error: any): string {
    if (axios.isCancel(error)) {
      return 'CANCELLED';
    }
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return 'TIMEOUT';
    }
    if (error.response) {
      return 'HTTP_ERROR';
    }
    return 'NETWORK_ERROR';
  }
}
