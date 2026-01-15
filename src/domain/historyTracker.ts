/**
 * Historical position tracker for copy trading.
 *
 * Implements the "startup snapshot" strategy:
 * - Records all leader positions at startup as "historical"
 * - Historical positions are not copied (add/reduce/close)
 * - When a historical position is fully closed, it's cleared
 * - When a position direction flips (long→short), it becomes a new position
 *
 * This ensures followers don't copy into positions with different entry prices.
 *
 * Key fix: Tracks "last seen size" to detect position changes correctly
 * even when debounce merges multiple fills into one sync.
 */

import { logger, type Logger } from "../utils/logger.js";
import type { PositionSnapshot } from "./types.js";
import { StatePersistence } from "./statePersistence.js";

/**
 * Tracks historical positions and determines which trades can be copied.
 */
export class HistoryPositionTracker {
  private readonly persistence: StatePersistence;
  private historicalCoins: Set<string>;
  private initialized = false;
  
  /**
   * Tracks the last seen leader position size for each coin.
   * Used to detect position changes (especially from 0 → non-zero for re-opening).
   */
  private lastSeenLeaderSize: Map<string, number> = new Map();

  /**
   * Creates a new tracker with persistence.
   *
   * @param pairId - Unique identifier for this copy trading pair
   * @param leaderAddress - Leader's Ethereum address
   * @param stateDir - Directory for state persistence files
   * @param log - Logger instance
   */
  constructor(
    pairId: string,
    leaderAddress: string,
    stateDir: string,
    private readonly log: Logger = logger,
  ) {
    this.persistence = new StatePersistence(pairId, leaderAddress, stateDir, log);
    // Load historical coins from persisted state
    this.historicalCoins = this.persistence.getHistoricalCoins();
  }

  /**
   * Initializes the tracker with leader's current positions.
   *
   * Called at startup after fetching leader state from API.
   *
   * Behavior:
   * - First startup: Records all current positions as historical
   * - Restart: Validates persisted state against current positions
   *
   * @param leaderPositions - Current leader positions from API
   * @returns List of coins marked as historical
   */
  initialize(leaderPositions: ReadonlyMap<string, PositionSnapshot>): string[] {
    const isFirstStart = this.persistence.isFirstStart();

    if (isFirstStart) {
      // First startup: record all existing positions as historical
      this.log.info("First startup - recording existing positions as historical");

      for (const [coin, pos] of leaderPositions) {
        if (Math.abs(pos.size) > 1e-9) {
          this.historicalCoins.add(coin);
          this.persistence.recordHistoricalPosition(coin, pos.size);
        }
      }
    } else {
      // Restart: validate persisted state
      this.log.info("Restart - validating persisted historical positions");

      // Check each historical coin against current leader state
      for (const coin of Array.from(this.historicalCoins)) {
        const leaderPos = leaderPositions.get(coin);

        if (!leaderPos || Math.abs(leaderPos.size) < 1e-9) {
          // Leader no longer has this position - clear from historical
          this.log.info(`Historical position no longer exists`, { coin });
          this.historicalCoins.delete(coin);
          this.persistence.clearHistoricalPosition(coin, "closed");
        } else {
          // Verify direction hasn't flipped while we were offline
          const persisted = this.persistence.getHistoricalPosition(coin);
          if (persisted) {
            const wasLong = persisted.direction === "long";
            const nowLong = leaderPos.size > 0;

            if (wasLong !== nowLong) {
              // Direction flipped while offline - this is now a new position
              this.log.info(`Historical position direction flipped while offline`, {
                coin,
                wasDirection: persisted.direction,
                nowDirection: nowLong ? "long" : "short",
              });
              this.historicalCoins.delete(coin);
              this.persistence.clearHistoricalPosition(coin, "flipped");
            }
          }
        }
      }
    }

    // Initialize lastSeenLeaderSize with current leader positions
    for (const [coin, pos] of leaderPositions) {
      this.lastSeenLeaderSize.set(coin, pos.size);
    }

    this.initialized = true;
    const result = Array.from(this.historicalCoins);

    if (result.length > 0) {
      this.log.info("Historical positions (will not copy)", { coins: result });
    } else {
      this.log.info("No historical positions - all leader trades will be copied");
    }

    return result;
  }

  /**
   * Determines if a trade on a given coin can be copied.
   *
   * Decision logic:
   * 1. If coin is not in historical set → can copy (new position)
   * 2. If coin is historical and now size=0 → clear and return false (don't copy the close)
   * 3. If coin is historical and direction flipped → clear and return true (copy the flip)
   * 4. If coin WAS historical, was closed (lastSeen≈0), now re-opened → can copy (new position!)
   * 5. Otherwise → cannot copy (historical position operation)
   *
   * @param coin - Trading pair symbol
   * @param leaderSize - Leader's current position size for this coin
   * @returns true if this trade should be copied, false otherwise
   */
  canCopy(coin: string, leaderSize: number): boolean {
    if (!this.initialized) {
      this.log.warn("Tracker not initialized, refusing to copy", { coin });
      return false;
    }

    const lastSize = this.lastSeenLeaderSize.get(coin) ?? 0;
    const wasZero = Math.abs(lastSize) < 1e-9;
    const isNowZero = Math.abs(leaderSize) < 1e-9;
    const isNowNonZero = !isNowZero;
    
    // Always update lastSeenLeaderSize after getting the previous value
    this.lastSeenLeaderSize.set(coin, leaderSize);

    // Case 1: Not in historical set = new position, can copy
    if (!this.historicalCoins.has(coin)) {
      return true;
    }

    // Case 2: Position closed (size → 0)
    if (isNowZero) {
      this.log.info(`Historical position closed`, { coin, lastSize });
      this.historicalCoins.delete(coin);
      this.persistence.clearHistoricalPosition(coin, "closed");
      // Don't copy this close, but future trades on this coin can be copied
      return false;
    }

    // Case 3: Position re-opened after close (lastSize≈0, now non-zero, but was cleared from historical)
    // This handles the debounce merge scenario: close + re-open happen in one sync
    // The historical flag was removed (either by earlier canCopy call or initialize validation)
    // but we need to re-check: if lastSize was 0, this is truly a new position
    if (wasZero && isNowNonZero) {
      // This shouldn't happen if historicalCoins still contains the coin,
      // but let's handle it: last time we saw size=0, historical was cleared,
      // now it's non-zero, so it's a fresh position
      this.log.info(`Historical position re-opened after close, treating as new`, {
        coin,
        lastSize,
        newSize: leaderSize,
      });
      this.historicalCoins.delete(coin);
      this.persistence.clearHistoricalPosition(coin, "reopened");
      return true;
    }

    // Case 4: Check for direction flip
    const persisted = this.persistence.getHistoricalPosition(coin);
    if (persisted) {
      const wasLong = persisted.direction === "long";
      const nowLong = leaderSize > 0;

      if (wasLong !== nowLong) {
        // Direction flipped! This is effectively a new position
        this.log.info(`Historical position flipped direction, now copyable`, {
          coin,
          wasDirection: persisted.direction,
          nowDirection: nowLong ? "long" : "short",
        });
        this.historicalCoins.delete(coin);
        this.persistence.clearHistoricalPosition(coin, "flipped");
        return true;
      }
    }

    // Case 5: Historical position, same direction = don't copy
    this.log.debug(`Skipping historical position operation`, { coin, leaderSize });
    return false;
  }

  /**
   * Gets list of coins currently marked as historical.
   */
  getHistoricalCoins(): string[] {
    return Array.from(this.historicalCoins);
  }

  /**
   * Checks if a coin is marked as historical.
   */
  isHistorical(coin: string): boolean {
    return this.historicalCoins.has(coin);
  }

  /**
   * Stops the tracker and ensures state is persisted.
   */
  stop() {
    this.persistence.stop();
  }
}
