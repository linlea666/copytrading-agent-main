/**
 * Leader state management and target position computation.
 *
 * Extends TraderStateStore to track the leader's positions and compute
 * scaled target positions for the follower based on risk parameters.
 */

import type { RiskConfig } from "../config/index.js";
import { safeDivide } from "../utils/math.js";
import type { LeverageType, PositionSnapshot } from "./types.js";
import { TraderStateStore } from "./traderState.js";
import type { MarketMetadataService } from "../services/marketMetadata.js";

/**
 * Represents a target position that the follower should replicate.
 */
export interface TargetPosition {
  /** Trading pair */
  coin: string;
  /** Leader's position size (raw, not scaled) */
  leaderSize: number;
  /** Leader's leverage for this position (notional / leader's account value) */
  leaderLeverage: number;
  /** Current mark price for the asset */
  markPrice: number;
  /** Leader's leverage setting (e.g., 40 for 40x) */
  leaderLeverageSetting: number;
  /** Leader's leverage type: "cross" or "isolated" */
  leaderLeverageType: LeverageType;
  /** Leader's position change since last check (positive = adding, negative = reducing) */
  leaderDeltaSize: number;
}

/**
 * Manages leader account state and computes target positions for the follower.
 */
export class LeaderState extends TraderStateStore {
  /** Tracks previous position sizes to detect leader's direction of change */
  private previousSizes: Map<string, number> = new Map();

  constructor() {
    super("leader");
  }

  /**
   * Computes target positions for the follower by analyzing leader's leverage.
   *
   * Instead of copying absolute position sizes, we copy the LEVERAGE RATIO.
   * This allows the follower to scale positions proportionally to their account size.
   *
   * Uses CURRENT MARK PRICE for leverage calculations, not entry price.
   * This ensures leverage is based on current market value.
   *
   * Also tracks leader's position changes to determine direction (adding vs reducing).
   *
   * @param metadataService - Service providing current mark prices
   * @returns Array of target positions with leader's leverage info and delta
   */
  computeTargets(metadataService: MarketMetadataService): TargetPosition[] {
    const metrics = this.getMetrics();
    const leaderEquity = metrics.accountValueUsd;
    
    const targets = Array.from(this.getPositions().values()).map((position) => {
      // Use CURRENT mark price for leverage calculation
      const markPrice = metadataService.getMarkPrice(position.coin) ?? position.entryPrice;
      
      // Calculate leader's current leverage for this position
      const notionalUsd = Math.abs(position.size) * markPrice;
      const leaderLeverage = safeDivide(notionalUsd, leaderEquity, 0);
      
      // Calculate leader's position change since last check
      const previousSize = this.previousSizes.get(position.coin) ?? 0;
      const leaderDeltaSize = position.size - previousSize;
      
      return {
        coin: position.coin,
        leaderSize: position.size,
        leaderLeverage,
        markPrice,
        leaderLeverageSetting: position.leverage,
        leaderLeverageType: position.leverageType,
        leaderDeltaSize,
      };
    });
    
    // Update previous sizes for next comparison
    // Also handle closed positions (size became 0)
    const currentCoins = new Set(targets.map(t => t.coin));
    for (const [coin, prevSize] of this.previousSizes) {
      if (!currentCoins.has(coin)) {
        // Position was closed, record as delta toward 0
        this.previousSizes.delete(coin);
      }
    }
    for (const target of targets) {
      this.previousSizes.set(target.coin, target.leaderSize);
    }
    
    return targets;
  }

  /**
   * Gets a specific position by coin symbol.
   */
  getPosition(coin: string): PositionSnapshot | undefined {
    return this.getPositions().get(coin);
  }
}
