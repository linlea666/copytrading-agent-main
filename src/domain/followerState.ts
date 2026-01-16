/**
 * Follower state management.
 *
 * Extends TraderStateStore to track the follower's positions.
 * Provides access to position data for SignalProcessor.
 *
 * NOTE: Delta computation has been removed.
 * Trading decisions are now based on leader's WebSocket fill events.
 */

import type { PositionSnapshot } from "./types.js";
import { TraderStateStore } from "./traderState.js";

/**
 * Manages follower account state.
 */
export class FollowerState extends TraderStateStore {
  constructor() {
    super("follower");
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

  /**
   * Checks if follower has a position in the given coin.
   */
  hasPosition(coin: string): boolean {
    const pos = this.getPositions().get(coin);
    return pos !== undefined && Math.abs(pos.size) > 1e-9;
  }
}
