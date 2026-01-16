/**
 * WebSocket subscription service for real-time leader fill events.
 *
 * Subscribes to the leader's fill stream on Hyperliquid and:
 * - Passes fill events to SignalProcessor for copy trading
 * - Updates leader state incrementally with each fill
 *
 * This is the single source of trading signals.
 * All copy trades are triggered by WebSocket fill events.
 */

import type * as hl from "@nktkas/hyperliquid";
import type { CopyTradingConfig } from "../config/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LeaderState } from "../domain/leaderState.js";
import { SignalProcessor } from "./signalProcessor.js";
import { formatTimestamp } from "../utils/math.js";

/**
 * Handle for managing an active subscription.
 */
type SubscriptionHandle = {
  unsubscribe: () => Promise<void>;
};

/**
 * Manages WebSocket subscriptions to leader account events.
 */
export class SubscriptionService {
  private fillsSub: SubscriptionHandle | null = null;

  /**
   * @param subscriptionClient - Hyperliquid WebSocket subscription client
   * @param config - Copy trading configuration
   * @param leaderState - Leader state store to update
   * @param signalProcessor - Signal processor for executing copy trades
   * @param log - Logger instance
   */
  constructor(
    private readonly subscriptionClient: hl.SubscriptionClient,
    private readonly config: CopyTradingConfig,
    private readonly leaderState: LeaderState,
    private readonly signalProcessor: SignalProcessor,
    private readonly log: Logger = logger,
  ) {}

  /**
   * Starts WebSocket subscription to leader fills.
   * No-op if already subscribed.
   */
  async start() {
    if (this.fillsSub) {
      return;
    }

    this.log.info("Starting leader subscriptions", { leader: this.config.leaderAddress });

    // Subscribe to leader's fill events
    const subscription = await this.subscriptionClient.userFills(
      {
        user: this.config.leaderAddress as `0x${string}`,
        aggregateByTime: this.config.websocketAggregateFills,
      },
      async (event) => {
        // Skip empty events
        if (event.fills.length === 0) {
          this.log.debug("Received empty fills event");
          return;
        }

        // CRITICAL: Skip snapshot data (historical fills)
        // When subscribing, the server first sends historical data with isSnapshot=true
        // We must ignore these to avoid replaying historical trades!
        if (event.isSnapshot) {
          const oldestFill = event.fills[event.fills.length - 1];
          const newestFill = event.fills[0];
          this.log.info("⏭️ Skipping historical snapshot data", {
            fillCount: event.fills.length,
            reason: "历史快照数据，不是实时信号",
            oldestFill: oldestFill ? formatTimestamp(oldestFill.time) : "N/A",
            newestFill: newestFill ? formatTimestamp(newestFill.time) : "N/A",
          });
          return;
        }

        // Log fill event details at INFO level for visibility
        this.log.info("📥 Received leader trade signal", {
          fillCount: event.fills.length,
          isSnapshot: false,
          trades: event.fills.map((fill) => ({
            coin: fill.coin,
            direction: fill.dir,
            side: fill.side === "B" ? "买入" : "卖出",
            size: fill.sz,
            price: "$" + fill.px,
            startPosition: fill.startPosition,
            time: formatTimestamp(fill.time),
          })),
        });

        // Update leader state incrementally
        this.leaderState.handleFillEvent(event);

        // Process signals through SignalProcessor
        // This is the single source of truth for copy trading
        try {
          await this.signalProcessor.processFillEvent(event);
        } catch (error) {
          this.log.error("Failed to process fill event", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    this.log.info("WebSocket subscription established successfully");

    this.fillsSub = {
      unsubscribe: () => subscription.unsubscribe(),
    };
  }

  /**
   * Stops WebSocket subscription to leader fills.
   * No-op if not subscribed.
   */
  async stop() {
    if (!this.fillsSub) {
      return;
    }
    this.log.info("Stopping leader subscriptions");
    await this.fillsSub.unsubscribe().catch((error) => {
      this.log.error("Failed to unsubscribe from fills", { error });
    });
    this.fillsSub = null;
  }
}
