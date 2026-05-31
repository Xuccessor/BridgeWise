export type StellarNetwork = 'public' | 'testnet' | 'futurenet';

export const STELLAR_NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

export const DEFAULT_STELLAR_HORIZON_URLS: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

export interface StellarNetworkDetectionResult {
  network: StellarNetwork;
  networkPassphrase: string;
  horizonUrl: string;
}

export interface StellarNetworkDetectorOptions {
  timeoutMs?: number;
  /**
   * Optional Horizon URL to detect against. When omitted, uses:
   * - `STELLAR_HORIZON_URL` env var, else
   * - built-in default Horizon URLs.
   */
  horizonUrl?: string;
}

export class StellarNetworkDetectionError extends Error {
  override name = 'StellarNetworkDetectionError';
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  { timeoutMs }: { timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHorizonRoot(
  horizonUrl: string,
  timeoutMs: number,
): Promise<{ network_passphrase?: unknown }> {
  const url = normalizeBaseUrl(horizonUrl);
  const response = await fetchWithTimeout(url, { timeoutMs });

  if (!response.ok) {
    throw new StellarNetworkDetectionError(
      `Horizon returned HTTP ${response.status} for ${url}`,
    );
  }

  const json: unknown = await response.json();
  if (!json || typeof json !== 'object') return {};
  return json as any;
}

export function resolveStellarNetworkFromPassphrase(
  networkPassphrase: string,
): StellarNetwork | null {
  const entries = Object.entries(STELLAR_NETWORK_PASSPHRASES) as Array<
    [StellarNetwork, string]
  >;

  for (const [network, passphrase] of entries) {
    if (passphrase === networkPassphrase) return network;
  }
  return null;
}

/**
 * Detect a Stellar network by querying the Horizon root endpoint and reading
 * `network_passphrase`.
 */
export async function detectStellarNetwork(
  options: StellarNetworkDetectorOptions = {},
): Promise<StellarNetworkDetectionResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const envHorizonUrl = process.env.STELLAR_HORIZON_URL;

  const horizonUrl = options.horizonUrl ?? envHorizonUrl ?? null;
  if (horizonUrl) {
    const root = await fetchHorizonRoot(horizonUrl, timeoutMs);
    const passphrase = root.network_passphrase;
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new StellarNetworkDetectionError(
        `Missing network_passphrase from Horizon root at ${normalizeBaseUrl(horizonUrl)}`,
      );
    }

    const network = resolveStellarNetworkFromPassphrase(passphrase);
    if (!network) {
      throw new StellarNetworkDetectionError(
        `Unknown Stellar network passphrase returned by ${normalizeBaseUrl(horizonUrl)}`,
      );
    }

    return {
      network,
      networkPassphrase: passphrase,
      horizonUrl: normalizeBaseUrl(horizonUrl),
    };
  }

  const candidates = Object.entries(DEFAULT_STELLAR_HORIZON_URLS) as Array<
    [StellarNetwork, string]
  >;

  const results = await Promise.allSettled(
    candidates.map(async ([network, url]) => {
      const root = await fetchHorizonRoot(url, timeoutMs);
      const passphrase = root.network_passphrase;

      if (typeof passphrase !== 'string' || !passphrase) {
        throw new StellarNetworkDetectionError(
          `Missing network_passphrase from Horizon root at ${normalizeBaseUrl(url)}`,
        );
      }

      const resolved = resolveStellarNetworkFromPassphrase(passphrase);
      if (!resolved) {
        throw new StellarNetworkDetectionError(
          `Unknown Stellar network passphrase returned by ${normalizeBaseUrl(url)}`,
        );
      }

      // The "active" network is whichever Horizon endpoint successfully
      // responds and self-identifies.
      return {
        network: resolved ?? network,
        networkPassphrase: passphrase,
        horizonUrl: normalizeBaseUrl(url),
      } satisfies StellarNetworkDetectionResult;
    }),
  );

  const fulfilled = results.find(
    (r): r is PromiseFulfilledResult<StellarNetworkDetectionResult> =>
      r.status === 'fulfilled',
  );

  if (fulfilled) return fulfilled.value;

  const reasons = results
    .filter((r) => r.status === 'rejected')
    .map((r) =>
      r.reason instanceof Error ? r.reason.message : String(r.reason),
    );

  throw new StellarNetworkDetectionError(
    `Failed to auto-detect Stellar network from default Horizon endpoints: ${reasons.join(
      '; ',
    )}`,
  );
}

