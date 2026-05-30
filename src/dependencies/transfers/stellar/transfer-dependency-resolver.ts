// ─── Types ────────────────────────────────────────────────────────────────────

export type TransferStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed';

export interface TransferMetadata {
  label?: string;
  priority?: number;       // higher = more urgent; used to sort ready transfers
  createdAt: Date;
  completedAt?: Date;
  failedAt?: Date;
  retryCount: number;
}

export interface TransferNode {
  id: string;
  status: TransferStatus;
  metadata: TransferMetadata;
}

export interface ResolverSnapshot {
  transfers: Array<{ id: string; status: TransferStatus; metadata: TransferMetadata }>;
  edges: Array<{ from: string; to: string }>;
}

export interface ResolverEventMap {
  ready: { transferId: string };
  completed: { transferId: string; completedAt: Date };
  failed: { transferId: string; failedAt: Date };
  added: { transferId: string };
  removed: { transferId: string };
  cleared: Record<string, never>;
}

type EventListener<T> = (payload: T) => void;

// ─── Class ────────────────────────────────────────────────────────────────────

class TransferDependencyResolver {
  private adjacencyList: Map<string, Set<string>> = new Map();
  private inDegree: Map<string, number> = new Map();
  private nodes: Map<string, TransferNode> = new Map();
  private listeners: { [K in keyof ResolverEventMap]?: Set<EventListener<ResolverEventMap[K]>> } = {};

  // ─── Core: Add / Remove ────────────────────────────────────────────────────

  /**
   * Register a transfer with optional dependencies and metadata.
   * Duplicate dependency edges are safely ignored.
   */
  addTransfer(
    transferId: string,
    dependencies: string[] = [],
    options: { label?: string; priority?: number } = {}
  ): void {
    this.ensureNode(transferId, options);

    for (const dep of dependencies) {
      this.ensureNode(dep);

      if (!this.adjacencyList.get(dep)!.has(transferId)) {
        this.adjacencyList.get(dep)!.add(transferId);
        this.inDegree.set(transferId, this.inDegree.get(transferId)! + 1);
      }
    }

    this.emit('added', { transferId });
    this.refreshStatus(transferId);
  }

  /**
   * Add multiple transfers at once.
   * Each entry: { id, dependencies?, label?, priority? }
   */
  addTransfers(
    entries: Array<{
      id: string;
      dependencies?: string[];
      label?: string;
      priority?: number;
    }>
  ): void {
    for (const entry of entries) {
      this.addTransfer(entry.id, entry.dependencies, {
        label: entry.label,
        priority: entry.priority,
      });
    }
  }

  /**
   * Remove a transfer and all of its edges from the graph.
   * Dependents of the removed transfer have their in-degree adjusted.
   */
  removeTransfer(transferId: string): void {
    if (!this.nodes.has(transferId)) return;

    // Remove incoming edges
    for (const [, edges] of this.adjacencyList.entries()) {
      if (edges.has(transferId)) {
        edges.delete(transferId);
        this.inDegree.set(transferId, Math.max(0, (this.inDegree.get(transferId) ?? 1) - 1));
      }
    }

    // Adjust dependents' in-degree
    const outgoing = this.adjacencyList.get(transferId);
    if (outgoing) {
      for (const dependent of outgoing) {
        this.inDegree.set(dependent, Math.max(0, (this.inDegree.get(dependent) ?? 1) - 1));
        this.refreshStatus(dependent);
      }
    }

    this.adjacencyList.delete(transferId);
    this.inDegree.delete(transferId);
    this.nodes.delete(transferId);

    this.emit('removed', { transferId });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Mark a transfer as in-progress (prevents it from being re-picked).
   */
  markInProgress(transferId: string): void {
    this.assertExists(transferId);
    this.setStatus(transferId, 'in_progress');
  }

  /**
   * Mark a transfer as completed and unblock its dependents.
   */
  markCompleted(transferId: string): void {
    this.assertExists(transferId);

    const node = this.nodes.get(transferId)!;
    node.status = 'completed';
    node.metadata.completedAt = new Date();

    const dependents = this.adjacencyList.get(transferId);
    if (dependents) {
      for (const dependent of dependents) {
        const newDegree = (this.inDegree.get(dependent) ?? 1) - 1;
        this.inDegree.set(dependent, Math.max(0, newDegree));
        this.refreshStatus(dependent);
      }
    }

    this.emit('completed', { transferId, completedAt: node.metadata.completedAt });
  }

  /**
   * Mark a transfer as failed (optionally track retry count).
   */
  markFailed(transferId: string, retry = false): void {
    this.assertExists(transferId);

    const node = this.nodes.get(transferId)!;
    node.status = 'failed';
    node.metadata.failedAt = new Date();
    if (retry) node.metadata.retryCount += 1;

    this.emit('failed', { transferId, failedAt: node.metadata.failedAt });
  }

  /**
   * Reset a failed transfer back to pending so it can be retried.
   */
  retryTransfer(transferId: string): void {
    this.assertExists(transferId);
    const node = this.nodes.get(transferId)!;
    if (node.status !== 'failed') {
      throw new Error(`Cannot retry transfer "${transferId}" — current status is "${node.status}"`);
    }
    node.metadata.retryCount += 1;
    node.metadata.failedAt = undefined;
    this.refreshStatus(transferId);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  /**
   * Returns transfers with no unresolved dependencies, sorted by priority (desc).
   */
  getReadyTransfers(): TransferNode[] {
    return [...this.nodes.values()]
      .filter((n) => n.status === 'ready')
      .sort((a, b) => (b.metadata.priority ?? 0) - (a.metadata.priority ?? 0));
  }

  /** Get a single transfer node by ID. */
  getTransfer(transferId: string): TransferNode | undefined {
    return this.nodes.get(transferId);
  }

  /** All transfer nodes. */
  getAllTransfers(): TransferNode[] {
    return [...this.nodes.values()];
  }

  /** Transfers filtered by status. */
  getByStatus(status: TransferStatus): TransferNode[] {
    return [...this.nodes.values()].filter((n) => n.status === status);
  }

  /**
   * Get all direct dependencies of a transfer (what it's waiting on).
   */
  getDependencies(transferId: string): string[] {
    this.assertExists(transferId);
    const deps: string[] = [];
    for (const [node, edges] of this.adjacencyList.entries()) {
      if (edges.has(transferId)) deps.push(node);
    }
    return deps;
  }

  /**
   * Get all direct dependents of a transfer (what's waiting on it).
   */
  getDependents(transferId: string): string[] {
    this.assertExists(transferId);
    return [...(this.adjacencyList.get(transferId) ?? [])];
  }

  /**
   * Get all transitive dependents of a transfer (the full downstream subtree).
   */
  getTransitiveDependents(transferId: string): string[] {
    this.assertExists(transferId);
    const visited = new Set<string>();
    const stack = [transferId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dep of this.adjacencyList.get(current) ?? []) {
        if (!visited.has(dep)) {
          visited.add(dep);
          stack.push(dep);
        }
      }
    }

    visited.delete(transferId);
    return [...visited];
  }

  /**
   * Count of transfers by status — useful for monitoring dashboards.
   */
  getSummary(): Record<TransferStatus, number> {
    const summary: Record<TransferStatus, number> = {
      pending: 0,
      ready: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const node of this.nodes.values()) {
      summary[node.status]++;
    }
    return summary;
  }

  // ─── Cycle Detection ───────────────────────────────────────────────────────

  /**
   * Returns true if the graph contains a cycle.
   */
  hasCircularDependencies(): boolean {
    return this.findCycle() !== null;
  }

  /**
   * Returns the IDs forming the first detected cycle, or null if none.
   * Useful for surfacing actionable error messages.
   */
  findCycle(): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const id of this.nodes.keys()) {
      color.set(id, WHITE);
      parent.set(id, null);
    }

    const dfs = (node: string): string[] | null => {
      color.set(node, GRAY);
      for (const neighbor of this.adjacencyList.get(node) ?? []) {
        if (color.get(neighbor) === GRAY) {
          // Reconstruct cycle
          const cycle: string[] = [neighbor];
          let current: string | null = node;
          while (current && current !== neighbor) {
            cycle.unshift(current);
            current = parent.get(current) ?? null;
          }
          cycle.unshift(neighbor);
          return cycle;
        }
        if (color.get(neighbor) === WHITE) {
          parent.set(neighbor, node);
          const result = dfs(neighbor);
          if (result) return result;
        }
      }
      color.set(node, BLACK);
      return null;
    };

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) {
        const cycle = dfs(id);
        if (cycle) return cycle;
      }
    }

    return null;
  }

  // ─── Execution Order ───────────────────────────────────────────────────────

  /**
   * Returns a valid topological execution order.
   * Throws a descriptive error (including the cycle path) if a cycle exists.
   */
  getExecutionOrder(): string[] {
    const cycle = this.findCycle();
    if (cycle) {
      throw new Error(
        `Circular dependency detected: ${cycle.join(' → ')}`
      );
    }

    const inDegreeCopy = new Map(this.inDegree);
    const queue: string[] = [];
    const result: string[] = [];

    for (const [id, degree] of inDegreeCopy.entries()) {
      if (degree === 0) queue.push(id);
    }

    // Sort initial queue by priority for deterministic, priority-aware ordering
    queue.sort(
      (a, b) =>
        (this.nodes.get(b)?.metadata.priority ?? 0) -
        (this.nodes.get(a)?.metadata.priority ?? 0)
    );

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const neighbors = [...(this.adjacencyList.get(current) ?? [])].sort(
        (a, b) =>
          (this.nodes.get(b)?.metadata.priority ?? 0) -
          (this.nodes.get(a)?.metadata.priority ?? 0)
      );

      for (const neighbor of neighbors) {
        const newDegree = inDegreeCopy.get(neighbor)! - 1;
        inDegreeCopy.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return result;
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Export the full graph as a plain object for persistence or debugging.
   */
  snapshot(): ResolverSnapshot {
    const edges: Array<{ from: string; to: string }> = [];
    for (const [from, targets] of this.adjacencyList.entries()) {
      for (const to of targets) {
        edges.push({ from, to });
      }
    }
    return {
      transfers: [...this.nodes.values()].map((n) => ({ ...n, metadata: { ...n.metadata } })),
      edges,
    };
  }

  /**
   * Restore graph state from a snapshot (replaces current state).
   */
  restore(snapshot: ResolverSnapshot): void {
    this.clear();
    for (const t of snapshot.transfers) {
      this.ensureNode(t.id, { label: t.metadata.label, priority: t.metadata.priority });
      this.nodes.get(t.id)!.status = t.status;
      this.nodes.get(t.id)!.metadata = { ...t.metadata, createdAt: new Date(t.metadata.createdAt) };
    }
    for (const { from, to } of snapshot.edges) {
      this.adjacencyList.get(from)?.add(to);
      this.inDegree.set(to, (this.inDegree.get(to) ?? 0) + 1);
    }
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  on<K extends keyof ResolverEventMap>(event: K, listener: EventListener<ResolverEventMap[K]>): void {
    if (!this.listeners[event]) this.listeners[event] = new Set() as any;
    (this.listeners[event] as Set<EventListener<ResolverEventMap[K]>>).add(listener);
  }

  off<K extends keyof ResolverEventMap>(event: K, listener: EventListener<ResolverEventMap[K]>): void {
    (this.listeners[event] as Set<EventListener<ResolverEventMap[K]>> | undefined)?.delete(listener);
  }

  // ─── Maintenance ───────────────────────────────────────────────────────────

  /** Remove all completed transfers to free memory. */
  pruneCompleted(): number {
    const completed = [...this.nodes.values()].filter((n) => n.status === 'completed');
    for (const node of completed) this.removeTransfer(node.id);
    return completed.length;
  }

  /** Reset the entire graph. */
  clear(): void {
    this.adjacencyList.clear();
    this.inDegree.clear();
    this.nodes.clear();
    this.emit('cleared', {});
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private ensureNode(
    transferId: string,
    options: { label?: string; priority?: number } = {}
  ): void {
    if (!this.nodes.has(transferId)) {
      this.adjacencyList.set(transferId, new Set());
      this.inDegree.set(transferId, 0);
      this.nodes.set(transferId, {
        id: transferId,
        status: 'ready',
        metadata: {
          label: options.label,
          priority: options.priority ?? 0,
          createdAt: new Date(),
          retryCount: 0,
        },
      });
    }
  }

  private setStatus(transferId: string, status: TransferStatus): void {
    const node = this.nodes.get(transferId);
    if (node) node.status = status;
  }

  private refreshStatus(transferId: string): void {
    const node = this.nodes.get(transferId);
    if (!node || node.status === 'completed' || node.status === 'in_progress') return;

    const degree = this.inDegree.get(transferId) ?? 0;
    const newStatus: TransferStatus = degree === 0 ? 'ready' : 'pending';

    if (node.status !== newStatus) {
      node.status = newStatus;
      if (newStatus === 'ready') {
        this.emit('ready', { transferId });
      }
    }
  }

  private assertExists(transferId: string): void {
    if (!this.nodes.has(transferId)) {
      throw new Error(`Transfer "${transferId}" does not exist in the graph`);
    }
  }

  private emit<K extends keyof ResolverEventMap>(event: K, payload: ResolverEventMap[K]): void {
    const handlers = this.listeners[event] as Set<EventListener<ResolverEventMap[K]>> | undefined;
    if (handlers) {
      for (const handler of handlers) {
        try { handler(payload); } catch { /* listener errors must not crash the resolver */ }
      }
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const transferDependencyResolver = new TransferDependencyResolver();
export { TransferDependencyResolver };