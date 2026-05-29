/**
 * Stellar Reconnect Manager
 * Handles persisting Stellar wallet sessions and restoring them automatically
 */

import type { WalletManager } from '../../../WalletManager';
import type { WalletAccount } from '../../../types';

/**
 * Persisted session data format
 */
export interface StellarSession {
  /** The connected adapter identifier (e.g. 'freighter') */
  adapterId: string;
  /** The public key or account address */
  address: string;
  /** Connected chain ID (e.g. 'stellar:public') */
  chainId: string;
  /** Timestamp when session was connected */
  connectedAt: number;
}

export class StellarReconnectManager {
  private static readonly SESSION_KEY = 'bridgewise-stellar-session';
  private manager: WalletManager;

  constructor(manager: WalletManager) {
    this.manager = manager;
  }

  /**
   * Save the Stellar session state to localStorage
   */
  static saveSession(adapterId: string, account: WalletAccount): void {
    if (typeof window === 'undefined') return;

    const session: StellarSession = {
      adapterId,
      address: account.address,
      chainId: account.chainId,
      connectedAt: Date.now(),
    };

    try {
      window.localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      console.error('Failed to save Stellar wallet session:', error);
    }
  }

  /**
   * Clear the persisted Stellar session state
   */
  static clearSession(): void {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.removeItem(this.SESSION_KEY);
    } catch (error) {
      console.error('Failed to clear Stellar wallet session:', error);
    }
  }

  /**
   * Get the persisted Stellar session
   */
  static getSession(): StellarSession | null {
    if (typeof window === 'undefined') return null;

    try {
      const data = window.localStorage.getItem(this.SESSION_KEY);
      if (!data) return null;
      return JSON.parse(data) as StellarSession;
    } catch {
      return null;
    }
  }

  /**
   * Automatically reconnect the persisted Stellar session
   */
  async tryReconnect(): Promise<WalletAccount | null> {
    const session = StellarReconnectManager.getSession();
    if (!session) return null;

    // Reject and prune sessions older than 7 days
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - session.connectedAt > ONE_WEEK) {
      StellarReconnectManager.clearSession();
      return null;
    }

    try {
      const adapter = this.manager.getAdapter(session.adapterId);
      if (!adapter || !adapter.isAvailable) {
        return null;
      }

      // Automatically reconnect the adapter using the persisted chainId
      const account = await this.manager.connect(session.adapterId, session.chainId);
      return account;
    } catch (error) {
      console.warn(`Failed to auto-reconnect Stellar wallet (${session.adapterId}):`, error);
      StellarReconnectManager.clearSession();
      return null;
    }
  }
}
