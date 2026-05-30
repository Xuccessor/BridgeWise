import { Route, RouteScore } from './route.types';
import { RouteScorer } from './route.scorer';

export class SorobanRouteOptimizer {
  optimize(routes: Route[]): Route | null {
    if (!routes.length) {
      return null;
    }

    const scoredRoutes: RouteScore[] = routes.map(route => ({
      route,
      score: RouteScorer.score(route),
    }));

    scoredRoutes.sort((a, b) => b.score - a.score);

    return scoredRoutes[0].route;
  }
}