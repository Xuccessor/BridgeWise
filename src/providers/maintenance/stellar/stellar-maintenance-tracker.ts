import type {
  MaintenanceStatus,
  MaintenanceTrackerOptions,
  MaintenanceWindow,
  OutageRecord,
  MaintenanceSnapshot,
  StatusChangeEvent,
} from "./types";

/**
 * Tracks maintenance windows and outages for a single Stellar bridge provider.
 *
 * Status priority (highest → lowest):
 *   outage > maintenance > degraded > operational
 *
 * Callers record outage detections/resolutions and schedule maintenance windows.
 * `getStatus()` derives the current status from these records at query time.
 */
export class StellarMaintenanceTracker {
  private readonly windows: MaintenanceWindow[] = [];
  private readonly outages: OutageRecord[] = [];
  private currentStatus: MaintenanceStatus = "operational";

  private readonly now: () => number;
  private readonly onStatusChange?: (event: StatusChangeEvent) => void;

  /** Assigned by the registry so events include the provider id. */
  providerId?: string;

  constructor(options: MaintenanceTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onStatusChange = options.onStatusChange;
  }

  // ─── Maintenance Windows ──────────────────────────────────────────────────

  /**
   * Schedule a maintenance window.
   * Throws if `startsAt >= endsAt`.
   */
  scheduleWindow(window: MaintenanceWindow): void {
    if (window.startsAt >= window.endsAt) {
      throw new RangeError("startsAt must be before endsAt");
    }
    if (this.windows.some((w) => w.id === window.id)) {
      throw new Error(`Window with id "${window.id}" already exists`);
    }
    this.windows.push({ ...window });
    this.refreshStatus();
  }

  /** Remove a scheduled window by id. No-op if not found. */
  cancelWindow(id: string): void {
    const idx = this.windows.findIndex((w) => w.id === id);
    if (idx !== -1) {
      this.windows.splice(idx, 1);
      this.refreshStatus();
    }
  }

  /** Active window at the current clock time, if any. */
  activeWindow(): MaintenanceWindow | null {
    const t = this.now();
    return this.windows.find((w) => w.startsAt <= t && t < w.endsAt) ?? null;
  }

  // ─── Outage Detection ────────────────────────────────────────────────────

  /**
   * Record that an outage was detected now.
   * No-op if an active outage is already open.
   */
  detectOutage(reason?: string): void {
    if (this.activeOutage()) return;
    this.outages.push({ detectedAt: this.now(), reason });
    this.refreshStatus();
  }

  /**
   * Resolve the currently active outage.
   * No-op if there is no active outage.
   */
  resolveOutage(): void {
    const active = this.activeOutage();
    if (!active) return;
    active.resolvedAt = this.now();
    this.refreshStatus();
  }

  /** The currently unresolved outage, if any. */
  activeOutage(): OutageRecord | null {
    return this.outages.find((o) => o.resolvedAt === undefined) ?? null;
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  /**
   * Current operational status derived from outage and window records.
   *
   * - `outage`      – an unresolved outage is open
   * - `maintenance` – inside a scheduled maintenance window
   * - `operational` – otherwise
   */
  getStatus(): MaintenanceStatus {
    if (this.activeOutage()) return "outage";
    if (this.activeWindow()) return "maintenance";
    return "operational";
  }

  /** Whether transfers should be blocked (outage or maintenance). */
  isUnavailable(): boolean {
    const s = this.getStatus();
    return s === "outage" || s === "maintenance";
  }

  // ─── Inspection ──────────────────────────────────────────────────────────

  getSnapshot(): MaintenanceSnapshot {
    return {
      status: this.getStatus(),
      activeWindow: this.activeWindow(),
      activeOutage: this.activeOutage(),
      scheduledWindows: [...this.windows],
      outageHistory: [...this.outages],
    };
  }

  /** Reset all state (windows + outages). */
  reset(): void {
    this.windows.length = 0;
    this.outages.length = 0;
    this.refreshStatus();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private refreshStatus(): void {
    const next = this.getStatus();
    if (next !== this.currentStatus) {
      const event: StatusChangeEvent = {
        providerId: this.providerId,
        from: this.currentStatus,
        to: next,
        at: this.now(),
      };
      this.currentStatus = next;
      this.onStatusChange?.(event);
    }
  }
}
