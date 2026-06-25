import { Injectable, Logger } from '@nestjs/common';

export interface RouteUtilizationMetrics {
  routeId: string;
  usageCount: number;
  lastUsed: Date;
}

export interface UtilizationReport {
  generatedAt: Date;
  metrics: RouteUtilizationMetrics[];
}

@Injectable()
export class StellarRouteUtilizationService {
  private readonly logger = new Logger(StellarRouteUtilizationService.name);
  private usageMap = new Map<string, RouteUtilizationMetrics>();

  trackRouteUsage(routeId: string): void {
    this.logger.log(`Tracking usage for route ${routeId}`);
    const existing = this.usageMap.get(routeId);
    if (existing) {
      existing.usageCount++;
      existing.lastUsed = new Date();
    } else {
      this.usageMap.set(routeId, {
        routeId,
        usageCount: 1,
        lastUsed: new Date()
      });
    }
  }

  aggregateMetrics(): RouteUtilizationMetrics[] {
    return Array.from(this.usageMap.values());
  }

  generateUtilizationReport(): UtilizationReport {
    this.logger.log('Generating utilization report');
    return {
      generatedAt: new Date(),
      metrics: this.aggregateMetrics(),
    };
  }
}
