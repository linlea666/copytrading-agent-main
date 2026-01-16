/**
 * Reconciliation service for periodically syncing state from Hyperliquid API.
 *
 * Fetches full account snapshots for both leader and follower to ensure
 * in-memory state matches the exchange.
 *
 * NOTE: This service only syncs state, it does NOT trigger trades.
 * All trading is driven by WebSocket fill events via SignalProcessor.
 *
 * Purposes:
 * - Startup initialization
 * - State display and logging
 * - Recovery after WebSocket disconnection
 * - Periodic state verification (backup mechanism)
 */

import type * as hl from "@nktkas/hyperliquid";
import type { CopyTradingConfig } from "../config/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";

/** Default reconciliation interval: 5 minutes (reduced from 1 minute) */
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Manages periodic reconciliation of leader and follower states.
 * NOTE: Only syncs state, does NOT trigger trades.
 */
export class Reconciler {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly infoClient: hl.InfoClient,
    private readonly config: CopyTradingConfig,
    private readonly leaderState: LeaderState,
    private readonly followerState: FollowerState,
    private readonly followerAddress: `0x${string}`,
    private readonly log: Logger = logger,
  ) {}

  /**
   * Performs a single reconciliation by fetching full clearinghouse state
   * for both leader and follower from the API.
   *
   * Fetches happen in parallel for efficiency.
   * NOTE: This only updates state, it does NOT trigger trades.
   */
  async reconcileOnce() {
    const [leader, follower] = await Promise.all([
      this.infoClient.clearinghouseState({ user: this.config.leaderAddress as `0x${string}` }),
      this.infoClient.clearinghouseState({ user: this.followerAddress }),
    ]);

    this.leaderState.applyClearinghouseState(leader);
    this.followerState.applyClearinghouseState(follower);

    // Log state summary for monitoring
    const leaderPositions = this.leaderState.getPositions();
    const followerPositions = this.followerState.getPositions();

    this.log.debug("State reconciliation completed", {
      leader: {
        equity: "$" + this.leaderState.getMetrics().accountValueUsd.toFixed(2),
        positions: leaderPositions.size,
        coins: Array.from(leaderPositions.keys()),
      },
      follower: {
        equity: "$" + this.followerState.getMetrics().accountValueUsd.toFixed(2),
        positions: followerPositions.size,
        coins: Array.from(followerPositions.keys()),
      },
    });
  }

  /**
   * Starts the periodic reconciliation loop.
   * No-op if already running.
   *
   * NOTE: This only syncs state periodically.
   * Trading is driven by WebSocket events, not by reconciliation.
   */
  start() {
    if (this.intervalHandle) {
      return;
    }

    // Use configured interval or default to 5 minutes
    const intervalMs = this.config.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;

    this.log.info("Starting reconciler (state sync only, no trading)", {
      intervalMs,
      intervalMinutes: (intervalMs / 60000).toFixed(1),
    });

    const tick = async () => {
      try {
        await this.reconcileOnce();
      } catch (error) {
        this.log.error("Reconciliation error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Schedule periodic ticks (don't run immediately, startup handles initial state)
    this.intervalHandle = setInterval(tick, intervalMs);
  }

  /**
   * Stops the periodic reconciliation loop.
   * No-op if not running.
   */
  stop() {
    if (!this.intervalHandle) {
      return;
    }
    this.log.info("Stopping reconciler");
    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
}
