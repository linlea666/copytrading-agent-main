/**
 * Leader state management.
 *
 * Extends TraderStateStore to track the leader's positions.
 * Provides access to position data for SignalProcessor.
 *
 * NOTE: Position delta calculation has been removed.
 * Trading direction is now determined by WebSocket fill's `dir` field.
 */

import type { PositionSnapshot } from "./types.js";
import { TraderStateStore } from "./traderState.js";

/**
 * Manages leader account state.
 */
export class LeaderState extends TraderStateStore {
  constructor() {
    super("leader");
  }

  /**
   * Gets a specific position by coin symbol.
   */
  getPosition(coin: string): PositionSnapshot | undefined {
    return this.getPositions().get(coin);
  }

  /**
   * Gets all coins that have open positions.
   */
  getPositionCoins(): string[] {
    return Array.from(this.getPositions().keys());
  }
}
