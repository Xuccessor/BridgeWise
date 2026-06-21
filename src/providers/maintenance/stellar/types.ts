// ─── Enums ────────────────────────────────────────────────────────────────────

export type MaintenanceStatus = "operational" | "maintenance" | "degraded" | "outage";

// ─── Maintenance Window ───────────────────────────────────────────────────────

export interface MaintenanceWindow {
  /** Unique identifier for this maintenance window. */
  id: string;
  /** Human-readable description of the work being performed. */
  description: string;
  /** Epoch ms when the window starts. */
  startsAt: number;
  /** Epoch ms when the window ends. */
  endsAt: number;
}

// ─── Outage ───────────────────────────────────────────────────────────────────

export interface OutageRecord {
  /** Epoch ms when the outage was first detected. */
  detectedAt: number;
  /** Epoch ms when the outage was resolved, or undefined if still active. */
  resolvedAt?: number;
  /** Optional human-readable reason. */
  reason?: string;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface MaintenanceTrackerOptions {
  /** Injectable clock for deterministic testing. Defaults to Date.now. */
  now?: () => number;
  /** Called whenever the provider status changes. */
  onStatusChange?: (event: StatusChangeEvent) => void;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface StatusChangeEvent {
  providerId?: string;
  from: MaintenanceStatus;
  to: MaintenanceStatus;
  at: number;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface MaintenanceSnapshot {
  status: MaintenanceStatus;
  /** Active maintenance window at the query time, if any. */
  activeWindow: MaintenanceWindow | null;
  /** Currently active outage, if any. */
  activeOutage: OutageRecord | null;
  /** All scheduled windows (past and future). */
  scheduledWindows: MaintenanceWindow[];
  /** Historical outage records (most recent last). */
  outageHistory: OutageRecord[];
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface ProviderMaintenanceStatus {
  providerId: string;
  snapshot: MaintenanceSnapshot;
}
