import { StellarOutageDetector, OutageAlert } from './stellar-outage-detector';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('StellarOutageDetector', () => {
  let detector: StellarOutageDetector;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    detector = new StellarOutageDetector({
      checkIntervalMs: 5000,
      timeoutMs: 1000,
      unhealthyThreshold: 2,
      degradedResponseTimeMs: 100,
      maxLedgerAgeMs: 30000, // 30 seconds
    });
  });

  afterEach(() => {
    detector.stopMonitoring();
    jest.useRealTimers();
  });

  describe('Endpoint Registration', () => {
    it('should register and cleanup Horizon and Soroban endpoints correctly', () => {
      detector.registerHorizonEndpoint('Horizon Mainnet', 'https://horizon.stellar.org/');
      detector.registerSorobanRpcEndpoint('Soroban Testnet', 'https://soroban-rpc-testnet.stellar.org');

      const states = detector.getStates();
      expect(states).toHaveLength(2);

      const horizonState = detector.getState('https://horizon.stellar.org');
      expect(horizonState).toBeDefined();
      expect(horizonState?.config.name).toBe('Horizon Mainnet');
      expect(horizonState?.config.type).toBe('horizon');
      expect(horizonState?.config.url).toBe('https://horizon.stellar.org'); // trailing slash removed
      expect(horizonState?.status).toBe('operational');

      const rpcState = detector.getState('https://soroban-rpc-testnet.stellar.org/');
      expect(rpcState).toBeDefined();
      expect(rpcState?.config.name).toBe('Soroban Testnet');
      expect(rpcState?.config.type).toBe('soroban-rpc');

      detector.unregisterEndpoint('https://horizon.stellar.org');
      expect(detector.getStates()).toHaveLength(1);
    });
  });

  describe('Horizon Endpoint Checking', () => {
    beforeEach(() => {
      detector.registerHorizonEndpoint('Horizon Mainnet', 'https://horizon.stellar.org');
    });

    it('should succeed and remain operational when response is healthy and ledger is fresh', async () => {
      const now = Date.now();
      const mockHorizonResponse = {
        data: {
          history_latest_ledger: 50000000,
          history_latest_ledger_closed_at: new Date(now - 5000).toISOString(), // 5s ago
        },
      };

      mockedAxios.get.mockResolvedValueOnce(mockHorizonResponse);

      const state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');

      expect(state.status).toBe('operational');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lastLedgerSequence).toBe(50000000);
      expect(state.lastLedgerCloseTime).toBe(new Date(mockHorizonResponse.data.history_latest_ledger_closed_at).getTime());
      expect(state.lastErrorMessage).toBeUndefined();
    });

    it('should transition to degraded when response time is high', async () => {
      const now = Date.now();
      const mockHorizonResponse = {
        data: {
          history_latest_ledger: 50000000,
          history_latest_ledger_closed_at: new Date(now - 5000).toISOString(),
        },
      };

      mockedAxios.get.mockImplementationOnce(() => {
        // Simulate response time > degradedResponseTimeMs (100ms)
        jest.advanceTimersByTime(150);
        return Promise.resolve(mockHorizonResponse);
      });

      const alerts: OutageAlert[] = [];
      detector.on('degraded', (alert) => alerts.push(alert));

      const state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');

      expect(state.status).toBe('degraded');
      expect(state.responseTimeMs).toBeGreaterThanOrEqual(150);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].currentStatus).toBe('degraded');
      expect(alerts[0].reason).toBe('HIGH_LATENCY');
    });

    it('should transition to outage when ledger age exceeds maxLedgerAgeMs (stagnation)', async () => {
      const now = Date.now();
      const mockHorizonResponse = {
        data: {
          history_latest_ledger: 50000000,
          history_latest_ledger_closed_at: new Date(now - 45000).toISOString(), // 45s ago (max ledger age is 30s)
        },
      };

      mockedAxios.get.mockResolvedValueOnce(mockHorizonResponse);

      const alerts: OutageAlert[] = [];
      detector.on('outage', (alert) => alerts.push(alert));

      // Threshold is 2 consecutive failures.
      // First failure transitions state to degraded (single failure buffer)
      let state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');
      expect(state.status).toBe('degraded');
      expect(state.consecutiveFailures).toBe(1);

      // Second failure transitions state to outage
      mockedAxios.get.mockResolvedValueOnce(mockHorizonResponse);
      state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');

      expect(state.status).toBe('outage');
      expect(state.consecutiveFailures).toBe(2);
      expect(state.lastErrorMessage).toContain('Stellar ledger stalled');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].currentStatus).toBe('outage');
      expect(alerts[0].reason).toBe('LEDGER_STALLED');
    });

    it('should transition to outage on HTTP errors and recover afterwards', async () => {
      const error = new Error('Request failed with status code 500') as any;
      error.response = { status: 500, data: 'Internal Server Error' };
      mockedAxios.get.mockRejectedValue(error);

      const statusChanges: OutageAlert[] = [];
      detector.on('status-change', (alert) => statusChanges.push(alert));

      // Attempt 1 -> transitions to degraded (since consecutiveFailures < threshold 2)
      let state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');
      expect(state.status).toBe('degraded');
      expect(state.consecutiveFailures).toBe(1);

      // Attempt 2 -> transitions to outage (reaches threshold 2)
      state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');
      expect(state.status).toBe('outage');
      expect(state.consecutiveFailures).toBe(2);
      expect(state.lastErrorMessage).toContain('HTTP 500');

      expect(statusChanges).toHaveLength(2);
      expect(statusChanges[0].currentStatus).toBe('degraded');
      expect(statusChanges[1].currentStatus).toBe('outage');

      // Recover: Mock a healthy response
      const mockHorizonResponse = {
        data: {
          history_latest_ledger: 50000001,
          history_latest_ledger_closed_at: new Date().toISOString(),
        },
      };
      mockedAxios.get.mockResolvedValueOnce(mockHorizonResponse);

      state = await detector.checkHorizonEndpoint('https://horizon.stellar.org');
      expect(state.status).toBe('operational');
      expect(state.consecutiveFailures).toBe(0);
      expect(statusChanges).toHaveLength(3);
      expect(statusChanges[2].previousStatus).toBe('outage');
      expect(statusChanges[2].currentStatus).toBe('operational');
    });
  });

  describe('Soroban RPC Endpoint Checking', () => {
    beforeEach(() => {
      detector.registerSorobanRpcEndpoint('Soroban RPC Mainnet', 'https://soroban-rpc.stellar.org');
    });

    it('should succeed and remain operational when RPC is healthy', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const mockRpcResponse = {
        data: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            sequence: 12345,
            closeTimestamp: nowSeconds - 5, // 5s ago
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockRpcResponse);

      const state = await detector.checkSorobanRpcEndpoint('https://soroban-rpc.stellar.org');

      expect(state.status).toBe('operational');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lastLedgerSequence).toBe(12345);
      expect(state.lastLedgerCloseTime).toBe((nowSeconds - 5) * 1000);
    });

    it('should transition to outage on JSON-RPC internal errors', async () => {
      const mockRpcResponseError = {
        data: {
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32603,
            message: 'Internal JSON-RPC Error',
          },
        },
      };

      // Fail 1
      mockedAxios.post.mockResolvedValueOnce(mockRpcResponseError);
      let state = await detector.checkSorobanRpcEndpoint('https://soroban-rpc.stellar.org');
      expect(state.status).toBe('degraded');

      // Fail 2
      mockedAxios.post.mockResolvedValueOnce(mockRpcResponseError);
      state = await detector.checkSorobanRpcEndpoint('https://soroban-rpc.stellar.org');
      expect(state.status).toBe('outage');
      expect(state.lastErrorMessage).toContain('JSON-RPC error: Internal JSON-RPC Error');
    });
  });

  describe('Periodic Polling', () => {
    it('should check all endpoints periodically when monitoring is started', async () => {
      detector.registerHorizonEndpoint('Horizon Mainnet', 'https://horizon.stellar.org');
      detector.registerSorobanRpcEndpoint('Soroban Mainnet', 'https://soroban-rpc.stellar.org');

      const mockHorizonResponse = {
        data: {
          history_latest_ledger: 50000000,
          history_latest_ledger_closed_at: new Date().toISOString(),
        },
      };
      const mockRpcResponse = {
        data: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            sequence: 12345,
            closeTimestamp: Math.floor(Date.now() / 1000),
          },
        },
      };

      // Mock resolved values for periodic checks
      mockedAxios.get.mockResolvedValue(mockHorizonResponse);
      mockedAxios.post.mockResolvedValue(mockRpcResponse);

      detector.startMonitoring();

      // Fast-forward initial async call
      await Promise.resolve(); 

      // Fast-forward periodic check interval (5000ms config)
      await jest.advanceTimersByTimeAsync(5000);

      // Verify checkAll was called
      expect(mockedAxios.get).toHaveBeenCalled();
      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });
});
