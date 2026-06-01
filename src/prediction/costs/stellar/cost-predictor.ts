export interface CostEstimate {
  routeId: string;
  baseFee: number;
  networkFee: number;
  totalFee: number;
  currency: string;
  estimatedAt: Date;
}

export interface RouteConditions {
  congestionLevel: 'low' | 'medium' | 'high';
  networkMultiplier: number;
}

export function estimateTransferCost(
  routeId: string,
  amount: number,
  conditions: RouteConditions
): CostEstimate {
  const baseFee = amount * 0.001;
  const networkFee = baseFee * conditions.networkMultiplier;
  return {
    routeId,
    baseFee: parseFloat(baseFee.toFixed(8)),
    networkFee: parseFloat(networkFee.toFixed(8)),
    totalFee: parseFloat((baseFee + networkFee).toFixed(8)),
    currency: 'XLM',
    estimatedAt: new Date(),
  };
}

export function getNetworkConditions(congestionLevel: 'low' | 'medium' | 'high'): RouteConditions {
  const multipliers = { low: 1.0, medium: 1.5, high: 2.5 };
  return { congestionLevel, networkMultiplier: multipliers[congestionLevel] };
}