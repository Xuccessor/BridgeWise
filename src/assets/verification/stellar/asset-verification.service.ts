export interface AssetVerificationResult {
  assetCode: string;
  issuer: string;
  verified: boolean;
  reason?: string;
}

const KNOWN_SUSPICIOUS_ISSUERS = new Set<string>();

export async function verifyAsset(
  assetCode: string,
  issuer: string,
  horizonUrl: string
): Promise<AssetVerificationResult> {
  if (KNOWN_SUSPICIOUS_ISSUERS.has(issuer)) {
    return { assetCode, issuer, verified: false, reason: 'Issuer is flagged as suspicious' };
  }

  if (!issuer.startsWith('G') || issuer.length !== 56) {
    return { assetCode, issuer, verified: false, reason: 'Invalid issuer address format' };
  }

  try {
    const res = await fetch(`${horizonUrl}/accounts/${issuer}`);
    if (!res.ok) {
      return { assetCode, issuer, verified: false, reason: 'Issuer account not found on network' };
    }
    return { assetCode, issuer, verified: true };
  } catch {
    return { assetCode, issuer, verified: false, reason: 'Network error during verification' };
  }
}

export function flagSuspiciousIssuer(issuer: string): void {
  KNOWN_SUSPICIOUS_ISSUERS.add(issuer);
}