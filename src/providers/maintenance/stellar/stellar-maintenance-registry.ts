import { StellarMaintenanceTracker } from "./stellar-maintenance-tracker";
import type {
  MaintenanceTrackerOptions,
  MaintenanceWindow,
  ProviderMaintenanceStatus,
} from "./types";

/**
 * Registry that manages one `StellarMaintenanceTracker` per Stellar bridge provider.
 *
 * Trackers are created lazily on first contact. The registry mirrors the
 * per-tracker API at the multi-provider level and provides routing helpers
 * so callers can avoid providers that are under maintenance or experiencing an
 * outage.
 */
export class StellarMaintenanceRegistry {
  private readonly trackers = new Map<string, StellarMaintenanceTracker>();

  constructor(private readonly options: MaintenanceTrackerOptions = {}) {}

  // ─── Maintenance Windows ─────────────────────────────────────────────────

  scheduleWindow(providerId: string, window: MaintenanceWindow): void {
    this.trackerFor(providerId).scheduleWindow(window);
  }

  cancelWindow(providerId: string, windowId: string): void {
    this.trackers.get(providerId)?.cancelWindow(windowId);
  }

  // ─── Outage Management ───────────────────────────────────────────────────

  detectOutage(providerId: string, reason?: string): void {
    this.trackerFor(providerId).detectOutage(reason);
  }

  resolveOutage(providerId: string): void {
    this.trackers.get(providerId)?.resolveOutage();
  }

  // ─── Routing Helpers ─────────────────────────────────────────────────────

  isAvailable(providerId: string): boolean {
    return !this.trackerFor(providerId).isUnavailable();
  }

  /**
   * Filter a candidate list down to providers that are operational.
   * Order is preserved so the caller's priority ranking is respected.
   */
  availableProviders(providerIds: string[]): string[] {
    return providerIds.filter((id) => this.isAvailable(id));
  }

  /**
   * Select the first available provider from an ordered list.
   * Returns `null` when all providers are unavailable.
   */
  selectProvider(providerIds: string[]): string | null {
    return this.availableProviders(providerIds)[0] ?? null;
  }

  // ─── Inspection ─────────────────────────────────────────────────────────

  /** Providers currently under maintenance or experiencing an outage. */
  unavailableProviders(): string[] {
    return this.allStatuses()
      .filter(({ snapshot }) => snapshot.status !== "operational")
      .map(({ providerId }) => providerId);
  }

  /** Full status snapshot for every known provider, sorted by id. */
  allStatuses(): ProviderMaintenanceStatus[] {
    return [...this.trackers.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerId, tracker]) => ({
        providerId,
        snapshot: tracker.getSnapshot(),
      }));
  }

  /** Status snapshot for a single provider, or `null` if never contacted. */
  statusFor(providerId: string): ProviderMaintenanceStatus | null {
    const tracker = this.trackers.get(providerId);
    if (!tracker) return null;
    return { providerId, snapshot: tracker.getSnapshot() };
  }

  /** Reset a single provider's tracker. */
  resetProvider(providerId: string): void {
    this.trackers.get(providerId)?.reset();
  }

  /** Reset all trackers. */
  resetAll(): void {
    for (const tracker of this.trackers.values()) tracker.reset();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private trackerFor(providerId: string): StellarMaintenanceTracker {
    let tracker = this.trackers.get(providerId);
    if (!tracker) {
      tracker = new StellarMaintenanceTracker(this.options);
      tracker.providerId = providerId;
      this.trackers.set(providerId, tracker);
    }
    return tracker;
  }
}
