import { StellarMaintenanceTracker } from "./stellar-maintenance-tracker";
import { StellarMaintenanceRegistry } from "./stellar-maintenance-registry";

// ─── StellarMaintenanceTracker ────────────────────────────────────────────────

describe("StellarMaintenanceTracker", () => {
  it("starts operational", () => {
    const tracker = new StellarMaintenanceTracker({ now: () => 1000 });
    expect(tracker.getStatus()).toBe("operational");
    expect(tracker.isUnavailable()).toBe(false);
  });

  describe("maintenance windows", () => {
    it("reports maintenance during a scheduled window", () => {
      let clock = 1000;
      const tracker = new StellarMaintenanceTracker({ now: () => clock });

      tracker.scheduleWindow({ id: "w1", description: "upgrade", startsAt: 1000, endsAt: 2000 });

      expect(tracker.getStatus()).toBe("maintenance");
      expect(tracker.isUnavailable()).toBe(true);

      clock = 2000; // window closed
      expect(tracker.getStatus()).toBe("operational");
    });

    it("returns operational before and after a window", () => {
      let clock = 500;
      const tracker = new StellarMaintenanceTracker({ now: () => clock });
      tracker.scheduleWindow({ id: "w1", description: "upgrade", startsAt: 1000, endsAt: 2000 });

      expect(tracker.getStatus()).toBe("operational");

      clock = 2000;
      expect(tracker.getStatus()).toBe("operational");
    });

    it("cancels a window correctly", () => {
      let clock = 1000;
      const tracker = new StellarMaintenanceTracker({ now: () => clock });
      tracker.scheduleWindow({ id: "w1", description: "upgrade", startsAt: 1000, endsAt: 2000 });
      expect(tracker.getStatus()).toBe("maintenance");

      tracker.cancelWindow("w1");
      expect(tracker.getStatus()).toBe("operational");
    });

    it("throws when startsAt >= endsAt", () => {
      const tracker = new StellarMaintenanceTracker();
      expect(() =>
        tracker.scheduleWindow({ id: "bad", description: "x", startsAt: 1000, endsAt: 1000 })
      ).toThrow(RangeError);
    });

    it("throws on duplicate window id", () => {
      const tracker = new StellarMaintenanceTracker({ now: () => 500 });
      tracker.scheduleWindow({ id: "w1", description: "first", startsAt: 1000, endsAt: 2000 });
      expect(() =>
        tracker.scheduleWindow({ id: "w1", description: "duplicate", startsAt: 3000, endsAt: 4000 })
      ).toThrow();
    });
  });

  describe("outage detection", () => {
    it("reports outage when an outage is detected", () => {
      const tracker = new StellarMaintenanceTracker({ now: () => 1000 });
      tracker.detectOutage("network failure");

      expect(tracker.getStatus()).toBe("outage");
      expect(tracker.isUnavailable()).toBe(true);
      expect(tracker.activeOutage()?.reason).toBe("network failure");
    });

    it("returns operational after outage is resolved", () => {
      let clock = 1000;
      const tracker = new StellarMaintenanceTracker({ now: () => clock });
      tracker.detectOutage();
      expect(tracker.getStatus()).toBe("outage");

      clock = 2000;
      tracker.resolveOutage();
      expect(tracker.getStatus()).toBe("operational");
      expect(tracker.activeOutage()).toBeNull();
    });

    it("outage takes priority over an active maintenance window", () => {
      let clock = 1000;
      const tracker = new StellarMaintenanceTracker({ now: () => clock });
      tracker.scheduleWindow({ id: "w1", description: "upgrade", startsAt: 1000, endsAt: 2000 });
      tracker.detectOutage("disk full");

      expect(tracker.getStatus()).toBe("outage");
    });

    it("ignores duplicate detectOutage calls", () => {
      const tracker = new StellarMaintenanceTracker({ now: () => 1000 });
      tracker.detectOutage("first");
      tracker.detectOutage("second"); // no-op
      expect(tracker.getSnapshot().outageHistory).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("clears all windows and outages", () => {
      const tracker = new StellarMaintenanceTracker({ now: () => 1000 });
      tracker.scheduleWindow({ id: "w1", description: "upgrade", startsAt: 1000, endsAt: 2000 });
      tracker.detectOutage();
      tracker.reset();

      expect(tracker.getStatus()).toBe("operational");
      const snap = tracker.getSnapshot();
      expect(snap.scheduledWindows).toHaveLength(0);
      expect(snap.outageHistory).toHaveLength(0);
    });
  });

  describe("onStatusChange callback", () => {
    it("fires when status transitions", () => {
      const events: string[] = [];
      const tracker = new StellarMaintenanceTracker({
        now: () => 1000,
        onStatusChange: (e) => events.push(`${e.from}→${e.to}`),
      });

      tracker.detectOutage();
      tracker.resolveOutage();

      expect(events).toEqual(["operational→outage", "outage→operational"]);
    });
  });
});

// ─── StellarMaintenanceRegistry ───────────────────────────────────────────────

describe("StellarMaintenanceRegistry", () => {
  it("marks unavailable providers and filters routing", () => {
    let clock = 1000;
    const registry = new StellarMaintenanceRegistry({ now: () => clock });

    registry.scheduleWindow("horizon-a", { id: "w1", description: "upgrade", startsAt: 1000, endsAt: 3000 });
    registry.detectOutage("horizon-b", "network");

    expect(registry.isAvailable("horizon-a")).toBe(false);
    expect(registry.isAvailable("horizon-b")).toBe(false);
    expect(registry.isAvailable("horizon-c")).toBe(true);

    expect(registry.availableProviders(["horizon-a", "horizon-b", "horizon-c"])).toEqual(["horizon-c"]);
    expect(registry.selectProvider(["horizon-a", "horizon-c"])).toBe("horizon-c");
    expect(registry.unavailableProviders()).toEqual(expect.arrayContaining(["horizon-a", "horizon-b"]));
  });

  it("selectProvider returns null when all are unavailable", () => {
    const registry = new StellarMaintenanceRegistry({ now: () => 1000 });
    registry.detectOutage("horizon-a");
    expect(registry.selectProvider(["horizon-a"])).toBeNull();
  });

  it("statusFor returns null for unknown providers", () => {
    const registry = new StellarMaintenanceRegistry();
    expect(registry.statusFor("unknown")).toBeNull();
  });

  it("resetProvider restores availability", () => {
    const registry = new StellarMaintenanceRegistry({ now: () => 1000 });
    registry.detectOutage("horizon-a");
    expect(registry.isAvailable("horizon-a")).toBe(false);
    registry.resolveOutage("horizon-a");
    expect(registry.isAvailable("horizon-a")).toBe(true);
  });
});
