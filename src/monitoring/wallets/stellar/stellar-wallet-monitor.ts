import type {
  WalletManager,
  WalletAdapter,
  WalletAccount,
} from '../../../../packages/wallet/src';
import { stellarMetrics } from '../../../exporters/metrics/stellar';
import { detectStellarNetwork } from '../../../networking/stellar';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CHECK_INTERVAL_MS = 15_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;

const HORIZON_URLS: Record<string, string> = {
  'stellar:public':   'https://horizon.stellar.org',
  'stellar:testnet':  'https://horizon-testnet.stellar.org',
  'stellar:futurenet':'https://horizon-futurenet.stellar.org',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletMonitorConfig {
  /** Polling interval for heartbeat checks in milliseconds. Default: 15 000. */
  checkIntervalMs?: number;
  /** Timeout for pings to the Stellar provider / Horizon in milliseconds. Default: 5 000. */
  pingTimeoutMs?: number;
  /** Custom Horizon URLs keyed by chain ID. Falls back to built-in defaults. */
  horizonUrls?: Record<string, string>;
  /**
   * When enabled, attempts to auto-detect the active Stellar network by querying
   * Horizon root endpoints and reading `network_passphrase`.
   *
   * You can also enable this via `STELLAR_AUTO_DETECT_NETWORK=true`.
   */
  autoDetectNetwork?: boolean;
  /** Called when an unhandled error escapes a listener. Defaults to console.error. */
  onListenerError?: (err: unknown, report: WalletHealthReport) => void;
}

export type WalletHealthStatus = 'healthy' | 'unhealthy' | 'disconnected';

export interface WalletHealthReport {
  walletId: string;
  address: string | null;
  status: WalletHealthStatus;
  providerConnected: boolean;
  horizonConnected: boolean;
  pingLatencyMs?: number;
  lastChecked: Date;
  error?: string;
}

export type HealthChangedCallback = (report: WalletHealthReport) => void;

// ─── Errors ───────────────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

/**
 * Monitors connectivity and health of connected Stellar wallets.
 *
 * - Polls every `checkIntervalMs` ms and on every connect/disconnect event.
 * - Emits health metrics via `stellarMetrics`.
 * - Notifies registered listeners only when status or error changes.
 * - `start()` / `stop()` are idempotent.
 */
export class StellarWalletMonitor {
  private readonly manager: WalletManager;
  private readonly config: Required<WalletMonitorConfig>;

  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private readonly healthReports = new Map<string, WalletHealthReport>();
  private readonly listeners = new Set<HealthChangedCallback>();

  /** Tracks in-flight per-wallet checks to prevent overlapping polls. */
  private readonly inFlight = new Set<string>();
  private detectedHorizonUrl: string | null = null;

  constructor(manager: WalletManager, config: WalletMonitorConfig = {}) {
    this.manager = manager;
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      pingTimeoutMs:   config.pingTimeoutMs   ?? DEFAULT_PING_TIMEOUT_MS,
      horizonUrls:     config.horizonUrls     ?? {},
      autoDetectNetwork:
        config.autoDetectNetwork ?? process.env.STELLAR_AUTO_DETECT_NETWORK === 'true',
      onListenerError: config.onListenerError ??
        ((err, report) =>
          console.error(`[StellarWalletMonitor] Listener error for ${report.walletId}:`, err)),
    };

    if (this.config.checkIntervalMs < 1_000) {
      throw new RangeError('checkIntervalMs must be ≥ 1 000 ms');
    }
    if (this.config.pingTimeoutMs < 100) {
      throw new RangeError('pingTimeoutMs must be ≥ 100 ms');
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start monitoring. Idempotent — calling twice has no effect.
   * Performs an immediate health sweep before the first poll fires.
   */
  start(): void {
    if (this.checkInterval) return;

    this.manager.on('connect', this.handleManagerConnect);
    this.manager.on('disconnect', this.handleManagerDisconnect);

    void this.checkAll();

    this.checkInterval = setInterval(
      () => void this.checkAll(),
      this.config.checkIntervalMs,
    );

    // Don't prevent Node.js from exiting if nothing else keeps the loop alive
    this.checkInterval.unref?.();
  }

  /**
   * Stop monitoring and remove all manager event listeners.
   * Idempotent — safe to call when already stopped.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.manager.off('connect', this.handleManagerConnect);
    this.manager.off('disconnect', this.handleManagerDisconnect);
  }

  get isRunning(): boolean {
    return this.checkInterval !== null;
  }

  // ─── Listeners ─────────────────────────────────────────────────────────

  onHealthChanged(callback: HealthChangedCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  offHealthChanged(callback: HealthChangedCallback): void {
    this.listeners.delete(callback);
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  getHealthReport(walletId: string): WalletHealthReport | null {
    return this.healthReports.get(walletId) ?? null;
  }

  getAllHealthReports(): WalletHealthReport[] {
    return [...this.healthReports.values()];
  }

  getHealthySummary(): { healthy: number; unhealthy: number; disconnected: number } {
    const counts = { healthy: 0, unhealthy: 0, disconnected: 0 };
    for (const r of this.healthReports.values()) counts[r.status]++;
    return counts;
  }

  // ─── Check orchestration ───────────────────────────────────────────────

  /**
   * Run health checks on all known Stellar adapters concurrently.
   * Skips adapters that already have an in-flight check to avoid pile-ups
   * under a slow network or a very short polling interval.
   */
  async checkAll(): Promise<void> {
    const adapters = this.getStellarAdapters();
    if (adapters.length === 0) return;

    const results = await Promise.allSettled(
      adapters
        .filter((a) => !this.inFlight.has(a.id))
        .map((a) => this.checkWallet(a)),
    );

    let activeCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 'healthy') activeCount++;
    }

    stellarMetrics.setWalletActiveConnections('stellar', activeCount);
  }

  /**
   * Perform a full health check on a single adapter.
   * Concurrent calls for the same wallet are deduplicated via `inFlight`.
   */
  async checkWallet(adapter: WalletAdapter): Promise<WalletHealthReport> {
    const { id: walletId } = adapter;

    if (this.inFlight.has(walletId)) {
      return this.healthReports.get(walletId) ?? this.makeDisconnectedReport(walletId, null);
    }

    this.inFlight.add(walletId);
    try {
      return await this.performCheck(adapter);
    } finally {
      this.inFlight.delete(walletId);
    }
  }

  // ─── Core check logic ──────────────────────────────────────────────────

  private async performCheck(adapter: WalletAdapter): Promise<WalletHealthReport> {
    const walletId = adapter.id;
    let account: WalletAccount | null = null;

    try {
      account = await adapter.getAccount();
    } catch {
      // Treat as disconnected — provider may have gone away
    }

    if (!account) {
      const report = this.makeDisconnectedReport(walletId, null);
      this.updateReport(walletId, report);
      return report;
    }

    const { address, chainId } = account;
    const checkStart = Date.now();

    const [providerResult, horizonResult] = await Promise.allSettled([
      this.checkProvider(adapter),
      this.checkHorizon(chainId, adapter),
    ]);

    const pingLatencyMs = Date.now() - checkStart;

    const providerConnected = providerResult.status === 'fulfilled' && providerResult.value.ok;
    const horizonConnected  = horizonResult.status  === 'fulfilled' && horizonResult.value.ok;

    // Collect first meaningful error string
    const errorMsg = this.firstError(providerResult, horizonResult);

    const status: WalletHealthStatus =
      providerConnected && horizonConnected ? 'healthy' : 'unhealthy';

    if (providerConnected) {
      stellarMetrics.recordWalletPingLatency(walletId, pingLatencyMs);
    }
    stellarMetrics.setWalletHealth(walletId, address, status === 'healthy' ? 1 : 0);

    const report: WalletHealthReport = {
      walletId,
      address,
      status,
      providerConnected,
      horizonConnected,
      pingLatencyMs: providerConnected ? pingLatencyMs : undefined,
      lastChecked: new Date(),
      error: errorMsg,
    };

    this.updateReport(walletId, report);
    return report;
  }

  // ─── Provider check ────────────────────────────────────────────────────

  private async checkProvider(
    adapter: WalletAdapter,
  ): Promise<{ ok: boolean; error?: string }> {
    const provider = (adapter as any).provider;

    if (!provider) {
      return { ok: false, error: 'Provider not initialised on adapter' };
    }

    if (typeof provider.isConnected === 'function' && !provider.isConnected()) {
      return { ok: false, error: 'Provider isConnected() returned false' };
    }

    try {
      await withTimeout(
        Promise.resolve(provider.publicKey()),
        this.config.pingTimeoutMs,
        'Provider publicKey() timed out',
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: `Provider error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── Horizon check ─────────────────────────────────────────────────────

  private async checkHorizon(
    chainId: string,
    adapter: WalletAdapter,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = await this.resolveHorizonUrl(chainId, adapter);

    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.config.pingTimeoutMs,
      );

      let response: Response;
      try {
        response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return { ok: true };
      return { ok: false, error: `Horizon returned HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: `Horizon unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async resolveHorizonUrl(
    chainId: string,
    adapter: WalletAdapter,
  ): Promise<string> {
    // 1. Caller-supplied override
    if (this.config.horizonUrls[chainId]) return this.config.horizonUrls[chainId];

    // 2. Adapter helper
    if (typeof (adapter as any).getHorizonUrl === 'function') {
      try {
        const url: unknown = (adapter as any).getHorizonUrl();
        if (typeof url === 'string' && url) return url;
      } catch {
        // Fall through
      }
    }

    // 3. Built-in defaults, matched by substring to handle variant chain ids
    for (const [key, url] of Object.entries(HORIZON_URLS)) {
      if (chainId.includes(key.split(':')[1]!)) return url;
    }

    // 4. Optional auto-detection
    if (this.config.autoDetectNetwork) {
      if (this.detectedHorizonUrl) return this.detectedHorizonUrl;
      try {
        const detected = await detectStellarNetwork({
          timeoutMs: this.config.pingTimeoutMs,
        });
        this.detectedHorizonUrl = detected.horizonUrl;
        return detected.horizonUrl;
      } catch {
        // Fall through
      }
    }

    // 5. Final fallback — mainnet
    return HORIZON_URLS['stellar:public']!;
  }

  // ─── Manager event handlers ────────────────────────────────────────────

  private handleManagerConnect = (data: { walletId: string }): void => {
    const adapter = this.manager.getAdapter(data.walletId);
    if (!adapter || adapter.networkType !== 'stellar') return;

    stellarMetrics.recordWalletConnection(data.walletId);
    void this.checkWallet(adapter);
  };

  private handleManagerDisconnect = (data: { walletId: string }): void => {
    const { walletId } = data;
    const adapter = this.manager.getAdapter(walletId);
    if (!adapter || adapter.networkType !== 'stellar') return;

    stellarMetrics.recordWalletDisconnect(walletId, 'user_disconnected');

    const address = this.healthReports.get(walletId)?.address ?? null;
    const report = this.makeDisconnectedReport(walletId, address);
    this.updateReport(walletId, report);

    if (address) stellarMetrics.setWalletHealth(walletId, address, 0);
  };

  // ─── Report helpers ────────────────────────────────────────────────────

  private updateReport(walletId: string, report: WalletHealthReport): void {
    const previous = this.healthReports.get(walletId);
    this.healthReports.set(walletId, report);

    const changed =
      !previous ||
      previous.status !== report.status ||
      previous.error  !== report.error;

    if (!changed) return;

    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch (err) {
        this.config.onListenerError(err, report);
      }
    }
  }

  private makeDisconnectedReport(
    walletId: string,
    address: string | null,
  ): WalletHealthReport {
    return {
      walletId,
      address,
      status: 'disconnected',
      providerConnected: false,
      horizonConnected: false,
      lastChecked: new Date(),
    };
  }

  private getStellarAdapters(): WalletAdapter[] {
    if (typeof this.manager.getStellarWallets === 'function') {
      return this.manager.getStellarWallets();
    }
    return this.manager.getAllAdapters().filter((a) => a.networkType === 'stellar');
  }

  private firstError(
    ...results: PromiseSettledResult<{ ok: boolean; error?: string }>[]
  ): string | undefined {
    for (const r of results) {
      if (r.status === 'rejected') return String(r.reason);
      if (!r.value.ok && r.value.error) return r.value.error;
    }
    return undefined;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
