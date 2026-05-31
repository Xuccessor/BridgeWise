import {
  detectStellarNetwork,
  resolveStellarNetworkFromPassphrase,
  StellarNetworkDetectionError,
  STELLAR_NETWORK_PASSPHRASES,
} from './stellar-network-detector';

describe('stellar-network-detector', () => {
  beforeEach(() => {
    delete process.env.STELLAR_HORIZON_URL;
  });

  it('resolves networks from known passphrases', () => {
    expect(resolveStellarNetworkFromPassphrase(STELLAR_NETWORK_PASSPHRASES.public)).toBe(
      'public',
    );
    expect(resolveStellarNetworkFromPassphrase(STELLAR_NETWORK_PASSPHRASES.testnet)).toBe(
      'testnet',
    );
    expect(resolveStellarNetworkFromPassphrase(STELLAR_NETWORK_PASSPHRASES.futurenet)).toBe(
      'futurenet',
    );
    expect(resolveStellarNetworkFromPassphrase('not-a-real-passphrase')).toBeNull();
  });

  it('detects network from a specific horizonUrl', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        network_passphrase: STELLAR_NETWORK_PASSPHRASES.testnet,
      }),
    }));

    const result = await detectStellarNetwork({
      horizonUrl: 'https://horizon-testnet.stellar.org/',
      timeoutMs: 250,
    });

    expect(result).toEqual({
      network: 'testnet',
      networkPassphrase: STELLAR_NETWORK_PASSPHRASES.testnet,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });
  });

  it('errors when horizon root response is missing network_passphrase', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await expect(
      detectStellarNetwork({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(StellarNetworkDetectionError);
  });
});

