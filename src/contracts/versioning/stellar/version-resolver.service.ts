import {
  ContractVersion,
  StellarEnvironment,
  ContractStatus,
  SorobanContract,
  ActiveContractInfo,
  VersionResolutionResult,
  VersionResolverConfig,
  VersionCompatibility,
  ContractVersionStats,
  ContractDeployment,
  DeploymentStatus,
  VersionNumberParts,
} from './version-resolver.types';
import { randomUUID } from 'crypto';

/**
 * Service for resolving active Soroban contract versions across Stellar environments.
 * Tracks deployed versions, manages version compatibility, and provides dynamic
 * contract resolution.
 *
 * @example
 * const resolver = new SorobanContractVersionResolver({
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   cacheExpirationMs: 60000,
 *   maxRetries: 3,
 *   retryDelayMs: 1000,
 *   environments: [StellarEnvironment.TESTNET, StellarEnvironment.PUBLIC],
 * });
 *
 * const activeVersion = await resolver.resolveActiveVersion(
 *   'CAU2YJ4XWQKZUADHZJ67H27NKAHQ3MK3NQRCMQKJ22RIRM32SFZKGGH',
 *   StellarEnvironment.TESTNET
 * );
 *
 * const result = resolver.registerVersion({
 *   contractId: 'CAU2YJ4...',
 *   version: '1.0.0',
 *   environment: StellarEnvironment.TESTNET,
 *   deployedBy: 'deployer@example.com',
 * });
 */
export class SorobanContractVersionResolver {
  private readonly config: VersionResolverConfig;
  private contracts = new Map<string, SorobanContract>();
  private versions = new Map<string, ContractVersion>();
  private versionCache = new Map<string, { data: string; expiresAt: number }>();
  private compatibilityMatrix = new Map<string, VersionCompatibility[]>();

  constructor(config: Partial<VersionResolverConfig> = {}) {
    this.config = {
      horizonUrl: config.horizonUrl || 'https://horizon-testnet.stellar.org',
      cacheExpirationMs: config.cacheExpirationMs || 60000,
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      environments: config.environments || [StellarEnvironment.TESTNET],
    };
  }

  /**
   * Register a new contract version
   */
  registerVersion(data: {
    contractId: string;
    name?: string;
    address?: string;
    version: string;
    versionNumber?: number;
    environment: StellarEnvironment;
    deployedBy: string;
    metadata?: Record<string, unknown>;
  }): ActiveContractInfo {
    const versionKey = this.getVersionKey(data.contractId, data.environment);
    const versionNumber = data.versionNumber || this.parseVersionNumber(data.version);

    const contractVersion: ContractVersion = {
      contractId: data.contractId,
      version: data.version,
      versionNumber,
      environment: data.environment,
      deployedAt: Date.now(),
      deployedBy: data.deployedBy,
      status: ContractStatus.ACTIVE,
      metadata: data.metadata,
    };

    this.versions.set(versionKey, contractVersion);

    // Update or create contract record
    let contract = this.contracts.get(data.contractId);
    if (!contract) {
      contract = {
        id: data.contractId,
        name: data.name || `Contract-${data.contractId.slice(0, 8)}`,
        address: data.address || data.contractId,
        currentVersion: data.version,
        previousVersions: [],
        environment: data.environment,
        deploymentHistory: [],
        metadata: data.metadata,
      };
    } else {
      if (contract.currentVersion !== data.version) {
        contract.previousVersions.push(contract.currentVersion);
      }
      contract.currentVersion = data.version;
    }

    contract.deploymentHistory.push({
      deploymentId: randomUUID(),
      contractId: data.contractId,
      version: data.version,
      timestamp: Date.now(),
      deployedBy: data.deployedBy,
      txHash: '', // Would be populated from actual deployment
      status: DeploymentStatus.SUCCESS,
    });

    this.contracts.set(data.contractId, contract);
    this.invalidateCache(versionKey);

    return {
      contractId: data.contractId,
      name: contract.name,
      address: contract.address,
      version: data.version,
      versionNumber,
      environment: data.environment,
      deployedAt: contractVersion.deployedAt,
      isActive: true,
      metadata: data.metadata,
    };
  }

  /**
   * Resolve the active version for a contract in a specific environment
   */
  async resolveActiveVersion(
    contractId: string,
    environment: StellarEnvironment,
  ): Promise<VersionResolutionResult> {
    const cacheKey = this.getVersionKey(contractId, environment);
    const cached = this.versionCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return JSON.parse(cached.data);
    }

    const versionKey = this.getVersionKey(contractId, environment);
    const version = this.versions.get(versionKey);

    if (!version) {
      throw new Error(`No version found for contract ${contractId} in ${environment}`);
    }

    const result: VersionResolutionResult = {
      contractId,
      resolvedVersion: version.version,
      versionNumber: version.versionNumber,
      resolvedAt: Date.now(),
      isActive: version.status === ContractStatus.ACTIVE,
      environment,
      compatibilityWarnings: this.checkCompatibilityWarnings(contractId, version),
    };

    this.versionCache.set(cacheKey, {
      data: JSON.stringify(result),
      expiresAt: Date.now() + this.config.cacheExpirationMs,
    });

    return result;
  }

  /**
   * Get all active contracts
   */
  getActiveContracts(environment?: StellarEnvironment): ActiveContractInfo[] {
    const contracts = Array.from(this.contracts.values());

    return contracts
      .filter((c) => !environment || c.environment === environment)
      .map((c) => ({
        contractId: c.id,
        name: c.name,
        address: c.address,
        version: c.currentVersion,
        versionNumber: this.parseVersionNumber(c.currentVersion),
        environment: c.environment,
        deployedAt: c.deploymentHistory[c.deploymentHistory.length - 1]?.timestamp || Date.now(),
        isActive: true,
        metadata: c.metadata,
      }));
  }

  /**
   * Get contract by ID
   */
  getContract(contractId: string): SorobanContract | undefined {
    return this.contracts.get(contractId);
  }

  /**
   * Get version history for a contract
   */
  getVersionHistory(contractId: string): ContractVersion[] {
    return Array.from(this.versions.values())
      .filter((v) => v.contractId === contractId)
      .sort((a, b) => b.deployedAt - a.deployedAt);
  }

  /**
   * Check compatibility between two versions
   */
  checkCompatibility(
    fromVersion: string,
    toVersion: string,
  ): VersionCompatibility {
    const matrixKey = `${fromVersion}->${toVersion}`;
    const existing = this.compatibilityMatrix.get(matrixKey);

    if (existing && existing.length > 0) {
      return existing[0];
    }

    const fromNum = this.parseVersionNumber(fromVersion);
    const toNum = this.parseVersionNumber(toVersion);

    // Simple semantic versioning compatibility check
    const compatible = toNum.major >= fromNum.major;

    const compatibility: VersionCompatibility = {
      fromVersion,
      toVersion,
      compatible,
      breakingChanges: compatible ? [] : [`Major version change: ${fromNum.major} -> ${toNum.major}`],
      deprecatedFields: [],
      newFields: [],
    };

    if (!this.compatibilityMatrix.has(matrixKey)) {
      this.compatibilityMatrix.set(matrixKey, []);
    }
    this.compatibilityMatrix.get(matrixKey)?.push(compatibility);

    return compatibility;
  }

  /**
   * Update contract status
   */
  updateContractStatus(
    contractId: string,
    status: ContractStatus,
    environment?: StellarEnvironment,
  ): boolean {
    const contract = this.contracts.get(contractId);
    if (!contract) return false;

    if (environment && contract.environment !== environment) {
      return false;
    }

    const versionKey = this.getVersionKey(contractId, contract.environment);
    const version = this.versions.get(versionKey);
    if (version) {
      version.status = status;
      this.invalidateCache(versionKey);
    }

    return true;
  }

  /**
   * Get version statistics
   */
  getStatistics(): ContractVersionStats {
    const contracts = Array.from(this.contracts.values());
    const environmentDist: Record<StellarEnvironment, number> = {
      [StellarEnvironment.TESTNET]: 0,
      [StellarEnvironment.PUBLIC]: 0,
      [StellarEnvironment.FUTURENET]: 0,
      [StellarEnvironment.STANDALONE]: 0,
    };

    for (const contract of contracts) {
      environmentDist[contract.environment]++;
    }

    const allDeployments = contracts.reduce(
      (sum, c) => sum + c.deploymentHistory.length,
      0,
    );

    return {
      totalContracts: contracts.length,
      activeContractCount: contracts.filter((c) => c.deploymentHistory.some((d) => d.status === DeploymentStatus.SUCCESS)).length,
      totalDeployments: allDeployments,
      lastDeploymentTime: Math.max(
        ...contracts.map((c) => c.deploymentHistory[c.deploymentHistory.length - 1]?.timestamp || 0),
      ),
      environmentDistribution: environmentDist,
    };
  }

  /**
   * Rollback to a previous version
   */
  rollbackVersion(contractId: string, targetVersion: string, environment: StellarEnvironment): boolean {
    const contract = this.contracts.get(contractId);
    if (!contract) return false;

    if (!contract.previousVersions.includes(targetVersion)) {
      return false;
    }

    contract.previousVersions = contract.previousVersions.filter((v) => v !== targetVersion);
    contract.previousVersions.push(contract.currentVersion);
    contract.currentVersion = targetVersion;

    contract.deploymentHistory.push({
      deploymentId: randomUUID(),
      contractId,
      version: targetVersion,
      timestamp: Date.now(),
      deployedBy: 'system',
      txHash: '',
      status: DeploymentStatus.ROLLED_BACK,
    });

    const versionKey = this.getVersionKey(contractId, environment);
    this.invalidateCache(versionKey);

    return true;
  }

  /**
   * Clear version cache
   */
  clearCache(): void {
    this.versionCache.clear();
  }

  // Private methods

  private getVersionKey(contractId: string, environment: StellarEnvironment): string {
    return `${contractId}@${environment}`;
  }

  private parseVersionNumber(version: string): { major: number; minor: number; patch: number } {
    const parts = version.split('.');
    return {
      major: parseInt(parts[0], 10) || 0,
      minor: parseInt(parts[1], 10) || 0,
      patch: parseInt(parts[2], 10) || 0,
    };
  }

  private checkCompatibilityWarnings(
    contractId: string,
    version: ContractVersion,
  ): string[] {
    const warnings: string[] = [];

    // Check if contract has deprecated versions
    const contract = this.contracts.get(contractId);
    if (contract && contract.previousVersions.length > 5) {
      warnings.push(`Contract has ${contract.previousVersions.length} previous versions. Consider cleanup.`);
    }

    // Check version age
    const ageMs = Date.now() - version.deployedAt;
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
    if (ageMonths > 6) {
      warnings.push(`Version is ${Math.floor(ageMonths)} months old. Consider updating.`);
    }

    return warnings;
  }

  private invalidateCache(key: string): void {
    this.versionCache.delete(key);
  }
}
