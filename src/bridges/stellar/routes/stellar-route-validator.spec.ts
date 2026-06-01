import {
  StellarRouteValidator,
  InvalidRouteError,
  stellarRouteValidator,
} from './stellar-route-validator';

describe('StellarRouteValidator', () => {
  let validator: StellarRouteValidator;

  beforeEach(() => {
    validator = new StellarRouteValidator({
      availableBridgeIds: ['bridge-a', 'bridge-b'],
    });
  });

  // ─── validateRoute ──────────────────────────────────────────────────────────

  describe('validateRoute', () => {
    it('returns isValid true for a well-formed route', () => {
      const result = validator.validateRoute({
        routeId: 'route-1',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
        amount: '100',
        asset: 'USDC',
      });

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts stellar-mainnet and stellar-testnet as source chains', () => {
      for (const src of ['stellar-mainnet', 'stellar-testnet']) {
        const result = validator.validateRoute({
          routeId: 'r',
          sourceChain: src,
          destinationChain: 'polygon',
          bridgeId: 'bridge-a',
        });
        expect(result.isValid).toBe(true);
      }
    });

    it('is case-insensitive for chain names', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'Stellar',
        destinationChain: 'Ethereum',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(true);
    });

    it('errors when routeId is empty', () => {
      const result = validator.validateRoute({
        routeId: '',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('routeId must be a non-empty string');
    });

    it('errors when sourceChain is not a Stellar chain', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toMatch(/Source chain "ethereum"/);
    });

    it('errors when destinationChain is unsupported', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'unknown-chain',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toMatch(/Destination chain "unknown-chain"/);
    });

    it('errors when source and destination chains are the same', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'stellar',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'sourceChain and destinationChain must be different',
      );
    });

    it('errors when bridgeId is not registered', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'unknown-bridge',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toMatch(/Bridge "unknown-bridge"/);
    });

    it('errors when amount is not a positive number', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
        amount: '-5',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toMatch(/amount/);
    });

    it('warns when no asset is provided', () => {
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
      });
      expect(result.isValid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  // ─── filterValidRoutes ──────────────────────────────────────────────────────

  describe('filterValidRoutes', () => {
    const routes = [
      {
        routeId: 'good',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
        asset: 'XLM',
      },
      {
        routeId: 'bad',
        sourceChain: 'stellar',
        destinationChain: 'nowhere',
        bridgeId: 'bridge-a',
        asset: 'XLM',
      },
    ];

    it('returns only valid routes', () => {
      const result = validator.filterValidRoutes(routes);
      expect(result).toHaveLength(1);
      expect(result[0].routeId).toBe('good');
    });

    it('throws InvalidRouteError when throwOnInvalid is true', () => {
      expect(() => validator.filterValidRoutes(routes, true)).toThrow(
        InvalidRouteError,
      );
    });
  });

  // ─── assertValid ───────────────────────────────────────────────────────────

  describe('assertValid', () => {
    it('does not throw for a valid route', () => {
      expect(() =>
        validator.assertValid({
          routeId: 'r',
          sourceChain: 'stellar',
          destinationChain: 'polygon',
          bridgeId: 'bridge-b',
          asset: 'USDC',
        }),
      ).not.toThrow();
    });

    it('throws InvalidRouteError for an invalid route', () => {
      expect(() =>
        validator.assertValid({
          routeId: 'bad-route',
          sourceChain: 'stellar',
          destinationChain: 'nowhere',
          bridgeId: 'bridge-a',
        }),
      ).toThrow(InvalidRouteError);
    });
  });

  // ─── bridge registration ───────────────────────────────────────────────────

  describe('registerBridge / deregisterBridge', () => {
    it('allows a newly registered bridge', () => {
      validator.registerBridge('bridge-new');
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-new',
        asset: 'XLM',
      });
      expect(result.isValid).toBe(true);
    });

    it('rejects a deregistered bridge', () => {
      validator.deregisterBridge('bridge-a');
      const result = validator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'bridge-a',
        asset: 'XLM',
      });
      expect(result.isValid).toBe(false);
    });
  });

  // ─── default instance ──────────────────────────────────────────────────────

  describe('default stellarRouteValidator', () => {
    it('validates with no bridge restriction', () => {
      const result = stellarRouteValidator.validateRoute({
        routeId: 'r',
        sourceChain: 'stellar',
        destinationChain: 'ethereum',
        bridgeId: 'any-bridge',
        asset: 'USDC',
      });
      expect(result.isValid).toBe(true);
    });
  });
});
