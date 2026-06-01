export interface RpcEndpoint {
  url: string;
  healthy: boolean;
  lastCheckedAt: Date;
}

export class StellarRpcLoadBalancer {
  private endpoints: RpcEndpoint[];
  private currentIndex = 0;

  constructor(urls: string[]) {
    this.endpoints = urls.map((url) => ({ url, healthy: true, lastCheckedAt: new Date() }));
  }

  getNextEndpoint(): string {
    const healthy = this.endpoints.filter((e) => e.healthy);
    if (healthy.length === 0) throw new Error('No healthy RPC endpoints available');
    const endpoint = healthy[this.currentIndex % healthy.length];
    this.currentIndex = (this.currentIndex + 1) % healthy.length;
    return endpoint.url;
  }

  async checkHealth(url: string): Promise<boolean> {
    try {
      const res = await fetch(`${url}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async refreshHealth(): Promise<void> {
    for (const endpoint of this.endpoints) {
      endpoint.healthy = await this.checkHealth(endpoint.url);
      endpoint.lastCheckedAt = new Date();
    }
  }

  getStatus(): RpcEndpoint[] {
    return [...this.endpoints];
  }
}