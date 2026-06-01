/**
 * Soroban contract version information
 */
export interface ContractVersion {
  contractId: string;
  version: string;
  versionNumber: VersionNumberParts;
  environment: StellarEnvironment;
  deployedAt: number;
  deployedBy: string;
  status: ContractStatus;
  metadata?: Record<string, unknown>;
}

/**
 * Stellar environments
 */
export enum StellarEnvironment {
  TESTNET = 'testnet',
  PUBLIC = 'public',
  FUTURENET = 'futurenet',
  STANDALONE = 'standalone',
}

/**
 * Contract deployment status
 */
export enum ContractStatus {
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  ARCHIVED = 'archived',
  FAILED = 'failed',
}

/**
 * Soroban contract reference
 */
export interface SorobanContract {
  id: string;
  name: string;
  address: string;
  currentVersion: string;
  previousVersions: string[];
  environment: StellarEnvironment;
  deploymentHistory: ContractDeployment[];
  metadata?: Record<string, unknown>;
}

/**
 * Contract deployment record
 */
export interface ContractDeployment {
  deploymentId: string;
  contractId: string;
  version: string;
  timestamp: number;
  deployedBy: string;
  txHash: string;
  status: DeploymentStatus;
  message?: string;
}

/**
 * Deployment status
 */
export enum DeploymentStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

/**
 * Version number parts
 */
export interface VersionNumberParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Active contract info including version
 */
export interface ActiveContractInfo {
  contractId: string;
  name: string;
  address: string;
  version: string;
  versionNumber: VersionNumberParts;
  environment: StellarEnvironment;
  deployedAt: number;
  isActive: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Version resolution result
 */
export interface VersionResolutionResult {
  contractId: string;
  resolvedVersion: string;
  versionNumber: number;
  resolvedAt: number;
  isActive: boolean;
  environment: StellarEnvironment;
  compatibilityWarnings: string[];
}

/**
 * Configuration for version resolver
 */
export interface VersionResolverConfig {
  horizonUrl: string;
  cacheExpirationMs: number;
  maxRetries: number;
  retryDelayMs: number;
  environments: StellarEnvironment[];
}

/**
 * Version compatibility information
 */
export interface VersionCompatibility {
  fromVersion: string;
  toVersion: string;
  compatible: boolean;
  breakingChanges: string[];
  deprecatedFields?: string[];
  newFields?: string[];
}

/**
 * Statistics about deployed contracts
 */
export interface ContractVersionStats {
  totalContracts: number;
  activeContractCount: number;
  totalDeployments: number;
  lastDeploymentTime: number;
  environmentDistribution: Record<StellarEnvironment, number>;
}
