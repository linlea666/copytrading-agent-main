/**
 * State persistence module for copy trading pairs.
 *
 * Persists historical position tracking state to JSON files,
 * enabling correct behavior across program restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger, type Logger } from "../utils/logger.js";

/**
 * Persisted historical position record.
 */
export interface PersistedPosition {
  /** Trading pair symbol (e.g., "BTC", "ETH") */
  coin: string;
  /** Position direction when recorded */
  direction: "long" | "short";
  /** Position size when recorded */
  size: number;
  /** Timestamp when this position was recorded as historical */
  recordedAt: string;
}

/**
 * Record of a cleared historical position.
 */
export interface ClearedPosition {
  /** Trading pair symbol */
  coin: string;
  /** Timestamp when cleared */
  clearedAt: string;
  /** Reason for clearing: position closed, direction flipped, or re-opened after close */
  reason: "closed" | "flipped" | "reopened";
}

/**
 * Complete persisted state for a copy trading pair.
 */
export interface PersistedPairState {
  /** Pair ID (must match config) */
  pairId: string;
  /** Timestamp of first ever startup */
  firstStartedAt: string;
  /** Timestamp of last run */
  lastRunAt: string;
  /** Leader address being tracked */
  leaderAddress: string;
  /** Historical positions that should not be copied */
  historicalPositions: PersistedPosition[];
  /** Positions that have been cleared from historical tracking */
  clearedPositions: ClearedPosition[];
  /** Schema version for future migrations */
  schemaVersion: number;
}

/** Current schema version */
const SCHEMA_VERSION = 1;

/**
 * Manages persistence of pair state to JSON files.
 *
 * Features:
 * - Automatic directory creation
 * - Debounced saves to reduce I/O
 * - Graceful handling of corrupted files
 * - Schema versioning for future migrations
 */
export class StatePersistence {
  private readonly filePath: string;
  private state: PersistedPairState;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    private readonly pairId: string,
    private readonly leaderAddress: string,
    stateDir: string,
    private readonly log: Logger = logger,
  ) {
    this.filePath = join(stateDir, `${pairId}.json`);
    this.state = this.load();
  }

  /**
   * Loads state from file, creating default state if file doesn't exist.
   */
  private load(): PersistedPairState {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      this.log.debug(`Created state directory: ${dir}`);
    }

    // Try to load existing state
    if (existsSync(this.filePath)) {
      try {
        const content = readFileSync(this.filePath, "utf-8");
        const state = JSON.parse(content) as PersistedPairState;

        // Validate loaded state
        if (state.pairId !== this.pairId) {
          this.log.warn(`State file pairId mismatch, creating new state`, {
            expected: this.pairId,
            found: state.pairId,
          });
        } else if (state.leaderAddress.toLowerCase() !== this.leaderAddress.toLowerCase()) {
          // Leader address changed - this is a significant change
          this.log.warn(`Leader address changed, resetting historical positions`, {
            previous: state.leaderAddress,
            current: this.leaderAddress,
          });
          // Reset historical positions but keep audit trail
          return this.createInitialState();
        } else {
          // Valid state loaded
          this.log.info(`Loaded persisted state`, {
            pairId: this.pairId,
            historicalPositions: state.historicalPositions.length,
            clearedPositions: state.clearedPositions.length,
            lastRunAt: state.lastRunAt,
          });
          return state;
        }
      } catch (error) {
        this.log.warn(`Failed to load state file, creating new state`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Create new state for first startup
    return this.createInitialState();
  }

  /**
   * Creates initial state for first startup.
   */
  private createInitialState(): PersistedPairState {
    const now = new Date().toISOString();
    return {
      pairId: this.pairId,
      firstStartedAt: now,
      lastRunAt: now,
      leaderAddress: this.leaderAddress,
      historicalPositions: [],
      clearedPositions: [],
      schemaVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Schedules a debounced save (1 second delay).
   * Multiple rapid changes will be batched into a single write.
   */
  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
  }

  /**
   * Saves state immediately, canceling any pending debounced save.
   */
  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (!this.dirty) return;

    this.state.lastRunAt = new Date().toISOString();
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
      this.dirty = false;
      this.log.debug(`Saved state to ${this.filePath}`);
    } catch (error) {
      this.log.error(`Failed to save state`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Checks if this is the first startup (no historical positions recorded).
   */
  isFirstStart(): boolean {
    return this.state.historicalPositions.length === 0 && this.state.clearedPositions.length === 0;
  }

  /**
   * Records a position as historical (should not be copied).
   *
   * @param coin - Trading pair symbol
   * @param size - Current position size (determines direction)
   */
  recordHistoricalPosition(coin: string, size: number) {
    // Check if already recorded
    const existing = this.state.historicalPositions.find((p) => p.coin === coin);
    if (existing) return;

    const direction = size > 0 ? "long" : "short";
    this.state.historicalPositions.push({
      coin,
      direction,
      size,
      recordedAt: new Date().toISOString(),
    });

    this.log.info(`Recorded historical position`, { coin, direction, size });
    this.scheduleSave();
  }

  /**
   * Clears a position from historical tracking.
   * Called when position is closed, direction flips, or re-opened after close.
   *
   * @param coin - Trading pair symbol
   * @param reason - Why the position was cleared
   */
  clearHistoricalPosition(coin: string, reason: "closed" | "flipped" | "reopened") {
    const index = this.state.historicalPositions.findIndex((p) => p.coin === coin);
    if (index === -1) return;

    // Remove from historical and add to cleared (audit trail)
    this.state.historicalPositions.splice(index, 1);
    this.state.clearedPositions.push({
      coin,
      clearedAt: new Date().toISOString(),
      reason,
    });

    // Keep cleared positions list bounded (last 100)
    if (this.state.clearedPositions.length > 100) {
      this.state.clearedPositions = this.state.clearedPositions.slice(-100);
    }

    this.log.info(`Cleared historical position`, { coin, reason });
    this.scheduleSave();
  }

  /**
   * Gets all coins currently marked as historical.
   */
  getHistoricalCoins(): Set<string> {
    return new Set(this.state.historicalPositions.map((p) => p.coin));
  }

  /**
   * Gets detailed info for a historical position.
   */
  getHistoricalPosition(coin: string): PersistedPosition | undefined {
    return this.state.historicalPositions.find((p) => p.coin === coin);
  }

  /**
   * Gets all historical positions.
   */
  getAllHistoricalPositions(): readonly PersistedPosition[] {
    return this.state.historicalPositions;
  }

  /**
   * Stops the persistence manager, ensuring final state is saved.
   */
  stop() {
    this.saveNow();
  }
}
