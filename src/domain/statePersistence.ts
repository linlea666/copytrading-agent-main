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
 * Cached fund ratio for a coin (方案 A: 固定比例).
 * 
 * When a new position is opened, we cache the fund ratio (followerEquity / leaderEquity).
 * All subsequent add-position trades for this coin use this fixed ratio,
 * ensuring the follower's entry price aligns with the leader's.
 */
export interface CoinRatioCache {
  /** The cached fund ratio (followerEquity / leaderEquity at first open) */
  ratio: number;
  /** Timestamp when this ratio was cached */
  createdAt: string;
  /** Direction of the position when ratio was cached */
  direction: "long" | "short";
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
  /** Whether initial snapshot has been processed (prevents re-marking on restart) */
  initializedSnapshot: boolean;
  /** 
   * Cached fund ratios per coin (方案 A: 固定比例).
   * Key is coin symbol (e.g., "BTC", "ETH").
   * Used to maintain consistent entry prices between leader and follower.
   */
  coinRatioCache?: Record<string, CoinRatioCache>;
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
          // Migrate old state files that don't have initializedSnapshot
          // If state file exists and was loaded successfully, it means we've run before
          if (state.initializedSnapshot === undefined) {
            state.initializedSnapshot = true;  // Assume old files are already initialized
            this.log.info(`Migrated old state file, setting initializedSnapshot=true`);
          }
          
          // Migrate old state files that don't have coinRatioCache
          if (state.coinRatioCache === undefined) {
            state.coinRatioCache = {};
            this.log.info(`Migrated old state file, initializing coinRatioCache`);
          }
          
          // Valid state loaded
          this.log.info(`Loaded persisted state`, {
            pairId: this.pairId,
            historicalPositions: state.historicalPositions.length,
            clearedPositions: state.clearedPositions.length,
            coinRatioCacheCount: Object.keys(state.coinRatioCache).length,
            lastRunAt: state.lastRunAt,
            initializedSnapshot: state.initializedSnapshot,
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
      initializedSnapshot: false,
      coinRatioCache: {},
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
   * Checks if this is the first startup (initial snapshot not yet processed).
   * 
   * Fixed: Previously checked if historicalPositions was empty, which was wrong
   * because if leader had no positions at first startup, historicalPositions 
   * would be empty, and restart would wrongly treat it as first startup.
   */
  isFirstStart(): boolean {
    return !this.state.initializedSnapshot;
  }

  /**
   * Marks the initial snapshot as processed.
   * Call this after initialize() completes to prevent re-marking on restart.
   */
  markInitialized(): void {
    if (!this.state.initializedSnapshot) {
      this.state.initializedSnapshot = true;
      this.log.info("Marked initial snapshot as processed");
      this.scheduleSave();
    }
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

  // ============================================================
  // 方案 A: 固定比例缓存管理 (Coin Ratio Cache)
  // ============================================================

  /**
   * Gets the cached fund ratio for a coin.
   * Returns undefined if no ratio is cached for this coin.
   * 
   * @param coin - Trading pair symbol (e.g., "BTC")
   */
  getCoinRatio(coin: string): CoinRatioCache | undefined {
    return this.state.coinRatioCache?.[coin];
  }

  /**
   * Sets (caches) the fund ratio for a coin when opening a new position.
   * This ratio will be used for all subsequent add-position trades.
   * 
   * @param coin - Trading pair symbol
   * @param ratio - The fund ratio to cache (followerEquity / leaderEquity)
   * @param direction - Position direction ("long" or "short")
   */
  setCoinRatio(coin: string, ratio: number, direction: "long" | "short"): void {
    if (!this.state.coinRatioCache) {
      this.state.coinRatioCache = {};
    }

    this.state.coinRatioCache[coin] = {
      ratio,
      direction,
      createdAt: new Date().toISOString(),
    };

    this.log.info(`Cached fund ratio for ${coin}`, {
      coin,
      ratio: ratio.toFixed(8),
      direction,
    });
    this.scheduleSave();
  }

  /**
   * Clears the cached fund ratio for a coin.
   * Called when a position is fully closed or direction flips.
   * 
   * @param coin - Trading pair symbol
   * @param reason - Why the ratio is being cleared
   */
  clearCoinRatio(coin: string, reason: "closed" | "flipped"): void {
    if (!this.state.coinRatioCache?.[coin]) {
      return;
    }

    const cached = this.state.coinRatioCache[coin];
    delete this.state.coinRatioCache[coin];

    this.log.info(`Cleared fund ratio cache for ${coin}`, {
      coin,
      previousRatio: cached.ratio.toFixed(8),
      previousDirection: cached.direction,
      reason,
    });
    this.scheduleSave();
  }

  /**
   * Gets all cached coin ratios.
   */
  getAllCoinRatios(): Record<string, CoinRatioCache> {
    return this.state.coinRatioCache ?? {};
  }

  /**
   * Stops the persistence manager, ensuring final state is saved.
   */
  stop() {
    this.saveNow();
  }
}
