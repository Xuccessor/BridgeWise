// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StellarRoute {
  routeId: string;
  sourceChain: string;
  destinationChain: string;
  bridgeId: string;
  amount?: string;
  asset?: string;
}

export interface RouteValidationResult {
  routeId: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface StellarRouteValidatorOptions {
  /** Allowed source chain identifiers. Defaults to standard Stellar chain names. */
  allowedSourceChains?: string[];
  /** Allowed destination chain identifiers. Defaults to known EVM chains. */
  allowedDestinationChains?: string[];
  /** Registered bridge IDs that are available for routing. */
  availableBridgeIds?: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_STELLAR_SOURCE_CHAINS = [
  'stellar',
  'stellar-mainnet',
  'stellar-testnet',
];

const DEFAULT_EVM_DESTINATION_CHAINS = [
  'ethereum',
  'polygon',
  'bsc',
  'bnb',
  'arbitrum',
  'optimism',
  'base',
  'avalanche',
  'gnosis',
];

// ─── Error ────────────────────────────────────────────────────────────────────

export class InvalidRouteError extends Error {
  constructor(
    public readonly routeId: string,
    public readonly validationErrors: string[],
  ) {
    super(
      `Invalid Stellar bridge route "${routeId}": ${validationErrors.join('; ')}`,
    );
    this.name = 'InvalidRouteError';
  }
}

// ─── Validator ────────────────────────────────────────────────────────────────

export class StellarRouteValidator {
  private readonly allowedSourceChains: Set<string>;
  private readonly allowedDestinationChains: Set<string>;
  private readonly availableBridgeIds: Set<string>;

  constructor(options: StellarRouteValidatorOptions = {}) {
    this.allowedSourceChains = new Set(
      (options.allowedSourceChains ?? DEFAULT_STELLAR_SOURCE_CHAINS).map((c) =>
        c.toLowerCase(),
      ),
    );
    this.allowedDestinationChains = new Set(
      (
        options.allowedDestinationChains ?? DEFAULT_EVM_DESTINATION_CHAINS
      ).map((c) => c.toLowerCase()),
    );
    this.availableBridgeIds = new Set(options.availableBridgeIds ?? []);
  }

  /**
   * Validates a single Stellar bridge route.
   * Returns a detailed result describing any errors or warnings.
   */
  validateRoute(route: StellarRoute): RouteValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!route.routeId?.trim()) {
      errors.push('routeId must be a non-empty string');
    }

    if (!route.sourceChain?.trim()) {
      errors.push('sourceChain must be a non-empty string');
    } else if (
      !this.allowedSourceChains.has(route.sourceChain.toLowerCase())
    ) {
      errors.push(
        `Source chain "${route.sourceChain}" is not a recognised Stellar chain. ` +
          `Allowed: ${[...this.allowedSourceChains].join(', ')}`,
      );
    }

    if (!route.destinationChain?.trim()) {
      errors.push('destinationChain must be a non-empty string');
    } else if (
      !this.allowedDestinationChains.has(route.destinationChain.toLowerCase())
    ) {
      errors.push(
        `Destination chain "${route.destinationChain}" is not supported. ` +
          `Allowed: ${[...this.allowedDestinationChains].join(', ')}`,
      );
    }

    if (
      route.sourceChain?.trim() &&
      route.destinationChain?.trim() &&
      route.sourceChain.toLowerCase() === route.destinationChain.toLowerCase()
    ) {
      errors.push('sourceChain and destinationChain must be different');
    }

    if (!route.bridgeId?.trim()) {
      errors.push('bridgeId must be a non-empty string');
    } else if (
      this.availableBridgeIds.size > 0 &&
      !this.availableBridgeIds.has(route.bridgeId)
    ) {
      errors.push(
        `Bridge "${route.bridgeId}" is not registered as an available bridge`,
      );
    }

    if (route.amount !== undefined) {
      const parsed = parseFloat(route.amount);
      if (isNaN(parsed) || parsed <= 0) {
        errors.push(`amount "${route.amount}" must be a positive numeric value`);
      }
    }

    if (!route.asset?.trim()) {
      warnings.push('No asset specified; route will apply to any asset');
    }

    return {
      routeId: route.routeId ?? '',
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validates an array of routes and returns results for each.
   */
  validateRoutes(routes: StellarRoute[]): RouteValidationResult[] {
    return routes.map((r) => this.validateRoute(r));
  }

  /**
   * Filters out invalid routes and returns only the valid ones.
   * Throws InvalidRouteError on the first invalid route when throwOnInvalid is true.
   */
  filterValidRoutes(
    routes: StellarRoute[],
    throwOnInvalid = false,
  ): StellarRoute[] {
    const valid: StellarRoute[] = [];

    for (const route of routes) {
      const result = this.validateRoute(route);
      if (result.isValid) {
        valid.push(route);
      } else if (throwOnInvalid) {
        throw new InvalidRouteError(result.routeId, result.errors);
      }
    }

    return valid;
  }

  /**
   * Asserts a route is valid; throws InvalidRouteError if not.
   */
  assertValid(route: StellarRoute): void {
    const result = this.validateRoute(route);
    if (!result.isValid) {
      throw new InvalidRouteError(result.routeId, result.errors);
    }
  }

  /**
   * Returns true if the route passes all validation checks.
   */
  isValid(route: StellarRoute): boolean {
    return this.validateRoute(route).isValid;
  }

  /**
   * Register additional bridge IDs as available.
   */
  registerBridge(bridgeId: string): void {
    this.availableBridgeIds.add(bridgeId);
  }

  /**
   * Deregister a bridge ID.
   */
  deregisterBridge(bridgeId: string): void {
    this.availableBridgeIds.delete(bridgeId);
  }

  /**
   * Returns the set of allowed source chains.
   */
  getAllowedSourceChains(): string[] {
    return [...this.allowedSourceChains];
  }

  /**
   * Returns the set of allowed destination chains.
   */
  getAllowedDestinationChains(): string[] {
    return [...this.allowedDestinationChains];
  }
}

// ─── Default Instance ─────────────────────────────────────────────────────────

export const stellarRouteValidator = new StellarRouteValidator();
