import { Route } from './route.types';
import { ROUTE_WEIGHTS } from './route.constants';

export class RouteScorer {
  static score(route: Route): number {
    const feeScore = 100 - route.fee;
    const latencyScore = 100 - route.latency;

    return (
      feeScore * ROUTE_WEIGHTS.fee +
      latencyScore * ROUTE_WEIGHTS.latency +
      route.liquidity * ROUTE_WEIGHTS.liquidity +
      route.successRate * ROUTE_WEIGHTS.successRate
    );
  }
}