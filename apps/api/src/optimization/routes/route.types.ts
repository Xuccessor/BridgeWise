export interface Route {
  id: string;
  sourceChain: string;
  destinationChain: string;
  fee: number;
  latency: number;
  liquidity: number;
  successRate: number;
}

export interface RouteScore {
  route: Route;
  score: number;
}