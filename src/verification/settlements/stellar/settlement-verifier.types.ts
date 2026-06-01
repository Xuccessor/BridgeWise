/**
 * Represents a settlement record on the Stellar blockchain
 */
export interface SettlementRecord {
  settlementId: string;
  transferId: string;
  sourceChain: string;
  destinationChain: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  assetCode: string;
  status: SettlementStatus;
  sourceTransaction: string;
  destinationTransaction?: string;
  createdAt: number;
  completedAt?: number;
  sourceBlockHeight: number;
  destinationBlockHeight?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Settlement status lifecycle
 */
export enum SettlementStatus {
  INITIATED = 'initiated',
  LOCKED = 'locked',
  VALIDATED = 'validated',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  FAILED = 'failed',
  MISMATCHED = 'mismatched',
}

/**
 * Result of settlement verification
 */
export interface SettlementVerificationResult {
  settlementId: string;
  isValid: boolean;
  status: SettlementStatus;
  sourceConfirmed: boolean;
  destinationConfirmed: boolean;
  matchStatus: SettlementMatchStatus;
  inconsistencies: SettlementInconsistency[];
  verifiedAt: number;
  recommendedAction?: string;
}

/**
 * Types of settlement mismatches
 */
export enum SettlementMatchStatus {
  COMPLETE = 'complete',
  PARTIAL = 'partial',
  MISMATCH = 'mismatch',
  PENDING = 'pending',
}

/**
 * Details about a detected settlement inconsistency
 */
export interface SettlementInconsistency {
  type: InconsistencyType;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  field?: string;
  expectedValue?: unknown;
  actualValue?: unknown;
}

/**
 * Types of inconsistencies that can be detected
 */
export enum InconsistencyType {
  AMOUNT_MISMATCH = 'amount_mismatch',
  ASSET_MISMATCH = 'asset_mismatch',
  ADDRESS_MISMATCH = 'address_mismatch',
  TIMEOUT = 'timeout',
  MISSING_SOURCE = 'missing_source',
  MISSING_DESTINATION = 'missing_destination',
  CONFIRMATION_MISMATCH = 'confirmation_mismatch',
  STATUS_DIVERGENCE = 'status_divergence',
}

/**
 * Configuration for settlement verification
 */
export interface SettlementVerifierConfig {
  horizonUrl: string;
  confirmationThreshold: number;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

/**
 * Request to verify a settlement
 */
export interface VerifySettlementRequest {
  settlementId: string;
  sourceTransaction: string;
  destinationTransaction?: string;
  expectedAmount: string;
  expectedAsset: string;
  fromAddress: string;
  toAddress: string;
}

/**
 * Summary of settlement verification statistics
 */
export interface SettlementVerificationStats {
  totalVerifications: number;
  successfulVerifications: number;
  failedVerifications: number;
  mismatchedSettlements: number;
  averageVerificationTimeMs: number;
}
