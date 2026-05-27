export class SorobanRpcThrottler {
  private secCapacity: number;
  private secRefillRate: number; // tokens per ms
  private secTokens: number;
  private secLastRefill: number;

  private minCapacity: number;
  private minRefillRate: number; // tokens per ms
  private minTokens: number;
  private minLastRefill: number;

  constructor(maxRequestsPerSecond: number, maxRequestsPerMinute: number) {
    this.secCapacity = maxRequestsPerSecond;
    this.secRefillRate = maxRequestsPerSecond / 1000;
    this.secTokens = maxRequestsPerSecond;
    this.secLastRefill = Date.now();

    this.minCapacity = maxRequestsPerMinute;
    this.minRefillRate = maxRequestsPerMinute / 60000;
    this.minTokens = maxRequestsPerMinute;
    this.minLastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();

    // Refill second bucket
    const secElapsed = now - this.secLastRefill;
    if (secElapsed > 0) {
      this.secTokens = Math.min(this.secCapacity, this.secTokens + secElapsed * this.secRefillRate);
      this.secLastRefill = now;
    }

    // Refill minute bucket
    const minElapsed = now - this.minLastRefill;
    if (minElapsed > 0) {
      this.minTokens = Math.min(this.minCapacity, this.minTokens + minElapsed * this.minRefillRate);
      this.minLastRefill = now;
    }
  }

  /**
   * Tries to consume tokens. Returns wait time in milliseconds.
   * 0 means consumed successfully with no wait.
   */
  consume(tokens: number = 1): number {
    this.refill();

    if (this.secTokens >= tokens && this.minTokens >= tokens) {
      this.secTokens -= tokens;
      this.minTokens -= tokens;
      return 0;
    }

    // Calculate wait time for second bucket
    const secWait = this.secTokens >= tokens ? 0 : Math.ceil((tokens - this.secTokens) / this.secRefillRate);

    // Calculate wait time for minute bucket
    const minWait = this.minTokens >= tokens ? 0 : Math.ceil((tokens - this.minTokens) / this.minRefillRate);

    // We must wait for the maximum of both wait times
    return Math.max(secWait, minWait);
  }

  /**
   * Update limits dynamically
   */
  updateLimits(maxRequestsPerSecond: number, maxRequestsPerMinute: number): void {
    this.secCapacity = maxRequestsPerSecond;
    this.secRefillRate = maxRequestsPerSecond / 1000;
    this.secTokens = maxRequestsPerSecond;
    this.secLastRefill = Date.now();

    this.minCapacity = maxRequestsPerMinute;
    this.minRefillRate = maxRequestsPerMinute / 60000;
    this.minTokens = maxRequestsPerMinute;
    this.minLastRefill = Date.now();
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): { sec: number; min: number } {
    this.refill();
    return {
      sec: this.secTokens,
      min: this.minTokens,
    };
  }
}
