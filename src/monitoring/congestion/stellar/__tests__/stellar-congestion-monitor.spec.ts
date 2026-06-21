import { StellarCongestionMonitor } from '../stellar-congestion-monitor';

describe('StellarCongestionMonitor', () => {
  let monitor: StellarCongestionMonitor;

  beforeEach(() => {
    monitor = new StellarCongestionMonitor({
      timeoutMs: 10,
      historyWindowSize: 10,
      spikeMultiplier: 2.0,
      minDataPoints: 3,
      thresholds: {
        latencyMs: 1000,
        failureRate: 0.2,
        queueDepth: 50,
        throughput: 20,
        pendingTransactions: 200,
      },
    });
  });

  afterEach(() => {
    monitor.reset();
  });

  it('registers routes and tracks metrics', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status).not.toBeNull();
    expect(status?.status).toBe('normal');
    expect(status?.currentMetrics.latencyMs).toBe(500);
    expect(status?.currentMetrics.throughput).toBe(50);
  });

  it('detects elevated status when one threshold is breached', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status?.status).toBe('elevated');
  });

  it('detects congested status when two thresholds are breached', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.5,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status?.status).toBe('congested');
  });

  it('detects severe status when three or more thresholds are breached', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.5,
      queueDepth: 100,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status?.status).toBe('severe');
  });

  it('generates alerts when thresholds are breached', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const alerts = monitor.getActiveAlerts('route-1');
    expect(alerts.length).toBeGreaterThan(0);
    const latencyAlert = alerts.find(a => a.metric === 'latency');
    expect(latencyAlert).toBeDefined();
    expect(latencyAlert?.currentValue).toBe(1500);
    expect(latencyAlert?.severity).toBe('medium');
  });

  it('detects latency spikes using historical data', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 100,
      failureRate: 0.01,
      queueDepth: 5,
      throughput: 50,
      pendingTransactions: 10,
    }));

    for (let i = 0; i < 5; i++) {
      await monitor.checkRoute('route-1');
    }

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 300,
      failureRate: 0.01,
      queueDepth: 5,
      throughput: 50,
      pendingTransactions: 10,
    }));

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status?.status).toBe('elevated');
  });

  it('resolves alerts when metrics return to normal', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    let alerts = monitor.getActiveAlerts('route-1');
    expect(alerts.length).toBeGreaterThan(0);

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    alerts = monitor.getActiveAlerts('route-1');
    expect(alerts.length).toBe(0);
  });

  it('emits alert events when alerts are generated', async () => {
    const alerts: any[] = [];
    monitor.on('alert', (alert) => alerts.push(alert));

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].routeId).toBe('route-1');
  });

  it('emits status-change events when congestion status changes', async () => {
    const statusChanges: any[] = [];
    monitor.on('status-change', (status) => statusChanges.push(status));

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    await monitor.checkRoute('route-1');

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    expect(statusChanges.length).toBeGreaterThan(0);
  });

  it('unregisters routes and cleans up data', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    expect(monitor.getRouteStatus('route-1')).not.toBeNull();

    monitor.unregisterRoute('route-1');
    expect(monitor.getRouteStatus('route-1')).toBeNull();
    expect(monitor.getAllActiveAlerts().length).toBe(0);
  });

  it('supports custom severity calculations', async () => {
    monitor = new StellarCongestionMonitor({
      timeoutMs: 10,
      historyWindowSize: 10,
      spikeMultiplier: 2.0,
      minDataPoints: 3,
      thresholds: {
        latencyMs: 1000,
        failureRate: 0.2,
        queueDepth: 50,
        throughput: 20,
        pendingTransactions: 200,
      },
    });

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 4000,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');

    const alerts = monitor.getActiveAlerts('route-1');
    const latencyAlert = alerts.find(a => a.metric === 'latency');
    expect(latencyAlert?.severity).toBe('critical');
  });

  it('returns all statuses for monitored routes', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    monitor.registerRoute('route-2', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkAll();

    const statuses = monitor.getAllStatuses();
    expect(statuses.length).toBe(2);
    expect(statuses.find(s => s.routeId === 'route-1')?.status).toBe('normal');
    expect(statuses.find(s => s.routeId === 'route-2')?.status).toBe('elevated');
  });

  it('updates thresholds dynamically', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    monitor.updateThresholds({ latencyMs: 2000 });

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status?.status).toBe('normal');
  });

  it('handles probe timeouts gracefully', async () => {
    monitor.registerRoute('route-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        latencyMs: 100,
        failureRate: 0,
        queueDepth: 0,
        throughput: 50,
        pendingTransactions: 10,
      };
    });

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status).not.toBeNull();
    expect(status?.currentMetrics.failureRate).toBe(1.0);
  });

  it('handles probe errors gracefully', async () => {
    monitor.registerRoute('route-1', async () => {
      throw new Error('Probe failed');
    });

    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    expect(status).not.toBeNull();
    expect(status?.currentMetrics.failureRate).toBe(1.0);
  });

  it('maintains alert history across checks', async () => {
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    await monitor.checkRoute('route-1');

    const status = monitor.getRouteStatus('route-1');
    const unresolvedAlerts = status?.alertHistory.filter(a => !a.resolvedAt) || [];
    const resolvedAlerts = status?.alertHistory.filter(a => a.resolvedAt) || [];
    expect(unresolvedAlerts.length).toBeGreaterThan(0);
    expect(resolvedAlerts.length).toBe(0);
  });

  it('invokes onAlert callback when alerts are generated', async () => {
    let alertReceived: CongestionAlert | null = null;
    monitor = new StellarCongestionMonitor({
      timeoutMs: 10,
      historyWindowSize: 10,
      spikeMultiplier: 2.0,
      minDataPoints: 3,
      thresholds: {
        latencyMs: 1000,
        failureRate: 0.2,
        queueDepth: 50,
        throughput: 20,
        pendingTransactions: 200,
      },
      onAlert: (alert) => {
        alertReceived = alert;
      },
    });

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    expect(alertReceived).not.toBeNull();
    expect(alertReceived?.routeId).toBe('route-1');
  });

  it('invokes onStatusChange callback when status changes', async () => {
    let statusReceived: any = null;
    monitor = new StellarCongestionMonitor({
      timeoutMs: 10,
      historyWindowSize: 10,
      spikeMultiplier: 2.0,
      minDataPoints: 3,
      thresholds: {
        latencyMs: 1000,
        failureRate: 0.2,
        queueDepth: 50,
        throughput: 20,
        pendingTransactions: 200,
      },
      onStatusChange: (status) => {
        statusReceived = status;
      },
    });

    monitor.registerRoute('route-1', async () => ({
      latencyMs: 500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    monitor.registerRoute('route-1', async () => ({
      latencyMs: 1500,
      failureRate: 0.1,
      queueDepth: 10,
      throughput: 50,
      pendingTransactions: 50,
    }));

    await monitor.checkRoute('route-1');
    expect(statusReceived).not.toBeNull();
    expect(statusReceived.routeId).toBe('route-1');
  });

  it('invokes onError callback when probe errors occur', async () => {
    let errorReceived: unknown = null;
    monitor = new StellarCongestionMonitor({
      timeoutMs: 10,
      historyWindowSize: 10,
      spikeMultiplier: 2.0,
      minDataPoints: 3,
      thresholds: {
        latencyMs: 1000,
        failureRate: 0.2,
        queueDepth: 50,
        throughput: 20,
        pendingTransactions: 200,
      },
      onError: (error) => {
        errorReceived = error;
      },
    });

    monitor.registerRoute('route-1', async () => {
      throw new Error('Probe error');
    });

    await monitor.checkRoute('route-1');
    expect(errorReceived).toBeInstanceOf(Error);
  });
});
