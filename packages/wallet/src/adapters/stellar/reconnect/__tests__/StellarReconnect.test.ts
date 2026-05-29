import { WalletManager } from '../../../../WalletManager';
import { StellarReconnectManager } from '../StellarReconnectManager';
import { StellarBaseAdapter } from '../../StellarBaseAdapter';
import type { WalletAccount, StellarProvider, ChainId } from '../../../../types';

// Mock Stellar Adapter for testing reconnect
class MockStellarAdapter extends StellarBaseAdapter {
  readonly id = 'mock-stellar';
  readonly name = 'Mock Stellar';
  readonly type = 'custom' as const;
  readonly icon = undefined;

  public providerMock: any;
  public mockIsAvailable = true;

  constructor() {
    super({ defaultNetwork: 'public' });
  }

  get isAvailable(): boolean {
    return this.mockIsAvailable;
  }

  protected getProvider(): StellarProvider | null {
    return this.providerMock || null;
  }
}

describe('Soroban Wallet Auto-Reconnect System', () => {
  let manager: WalletManager;
  let adapter: MockStellarAdapter;
  let mockProvider: jest.Mocked<any>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    // Mock localStorage
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: jest.fn((key: string) => store[key] || null),
      setItem: jest.fn((key: string, val: any) => {
        store[key] = val.toString();
      }),
      removeItem: jest.fn((key: string) => {
        delete store[key];
      }),
      clear: jest.fn(() => {
        for (const k of Object.keys(store)) {
          delete store[k];
        }
      }),
    };
    Object.defineProperty(global, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });

    mockProvider = {
      publicKey: jest.fn().mockResolvedValue('GBMOCKACCOUNT1234567890'),
      signTransaction: jest.fn(),
      signData: jest.fn(),
      getNetwork: jest.fn().mockResolvedValue('Public Global Stellar Network ; September 2015'),
      isConnected: jest.fn().mockReturnValue(true),
    };

    adapter = new MockStellarAdapter();
    adapter.providerMock = mockProvider;

    manager = new WalletManager({
      adapters: [adapter],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Session Persistence', () => {
    it('should save session state to localStorage on successful connect', async () => {
      const account = await manager.connect('mock-stellar');

      expect(global.localStorage.setItem).toHaveBeenCalledWith(
        'bridgewise-stellar-session',
        expect.any(String)
      );

      const savedSession = StellarReconnectManager.getSession();
      expect(savedSession).not.toBeNull();
      expect(savedSession?.adapterId).toBe('mock-stellar');
      expect(savedSession?.address).toBe(account.address);
      expect(savedSession?.chainId).toBe('stellar:public');
    });

    it('should clear session state from localStorage on disconnect', async () => {
      await manager.connect('mock-stellar');
      await manager.disconnect('mock-stellar');

      expect(global.localStorage.removeItem).toHaveBeenCalledWith('bridgewise-stellar-session');
      expect(StellarReconnectManager.getSession()).toBeNull();
    });
  });

  describe('Auto-Reconnect Restoration', () => {
    it('should successfully restore an active persisted session', async () => {
      // Setup stored session
      const accountMock: WalletAccount = {
        address: 'GBMOCKACCOUNT1234567890',
        publicKey: 'GBMOCKACCOUNT1234567890',
        chainId: 'stellar:public',
        network: 'stellar',
      };
      StellarReconnectManager.saveSession('mock-stellar', accountMock);

      // Trigger auto-reconnect
      const account = await manager.autoReconnectStellar();

      expect(account).not.toBeNull();
      expect(account?.address).toBe('GBMOCKACCOUNT1234567890');
      expect(manager.getActiveAccount()?.address).toBe('GBMOCKACCOUNT1234567890');
      expect(manager.getActiveWallet()?.id).toBe('mock-stellar');
    });

    it('should not reconnect and should clear session if it is older than 7 days', async () => {
      const accountMock: WalletAccount = {
        address: 'GBMOCKACCOUNT1234567890',
        publicKey: 'GBMOCKACCOUNT1234567890',
        chainId: 'stellar:public',
        network: 'stellar',
      };

      // Persist session
      StellarReconnectManager.saveSession('mock-stellar', accountMock);

      // Backdate the session to 8 days ago
      const session = StellarReconnectManager.getSession()!;
      session.connectedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
      window.localStorage.setItem('bridgewise-stellar-session', JSON.stringify(session));

      // Trigger auto-reconnect
      const account = await manager.autoReconnectStellar();

      expect(account).toBeNull();
      expect(manager.getActiveAccount()).toBeNull();
      expect(StellarReconnectManager.getSession()).toBeNull(); // Cleared
    });

    it('should fail gracefully and clear session if adapter is unavailable', async () => {
      const accountMock: WalletAccount = {
        address: 'GBMOCKACCOUNT1234567890',
        publicKey: 'GBMOCKACCOUNT1234567890',
        chainId: 'stellar:public',
        network: 'stellar',
      };
      StellarReconnectManager.saveSession('mock-stellar', accountMock);

      // Make adapter unavailable
      adapter.mockIsAvailable = false;

      const account = await manager.autoReconnectStellar();

      expect(account).toBeNull();
      expect(manager.getActiveAccount()).toBeNull();
    });

    it('should trigger reconnect on manager creation if autoReconnect option is active', async () => {
      const accountMock: WalletAccount = {
        address: 'GBMOCKACCOUNT1234567890',
        publicKey: 'GBMOCKACCOUNT1234567890',
        chainId: 'stellar:public',
        network: 'stellar',
      };
      StellarReconnectManager.saveSession('mock-stellar', accountMock);

      const onConnectSpy = jest.fn();

      const newManager = new WalletManager({
        adapters: [adapter],
        autoReconnect: true,
        onConnect: onConnectSpy,
      });

      // Run microtasks/timeouts
      jest.runAllTimers();

      // Flush microtask queue to resolve all nested promises
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(newManager.getActiveAccount()?.address).toBe('GBMOCKACCOUNT1234567890');
    });
  });
});
