/**
 * Reconciliation service for periodically syncing state from Hyperliquid API.
 *
 * Fetches full account snapshots for both leader and follower to ensure
 * in-memory state matches the exchange.
 *
 * Features:
 * - Startup initialization
 * - State display and logging
 * - Recovery after WebSocket disconnection
 * - Periodic state verification (backup mechanism)
 * - **Fallback full close**: If leader has no position but follower does, close it
 *
 * The fallback full close ensures position consistency even when WebSocket signals are lost.
 */

import type * as hl from "@nktkas/hyperliquid";
import type { CopyTradingConfig } from "../config/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { EPSILON, clamp, roundToMarkPricePrecision } from "../utils/math.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import type { MarketMetadataService } from "./marketMetadata.js";
import { randomUUID } from "node:crypto";

/** Default reconciliation interval: 5 minutes (reduced from 1 minute) */
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Optional dependencies for fallback full close feature.
 */
export interface ReconcilerFallbackDeps {
  exchangeClient: hl.ExchangeClient;
  metadataService: MarketMetadataService;
  historyTracker: HistoryPositionTracker;
  marketOrderSlippage?: number;
}

/**
 * Manages periodic reconciliation of leader and follower states.
 * Also performs fallback full close when leader has no position but follower does.
 */
export class Reconciler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private fallbackDeps: ReconcilerFallbackDeps | null = null;

  constructor(
    private readonly infoClient: hl.InfoClient,
    private readonly config: CopyTradingConfig,
    private readonly leaderState: LeaderState,
    private readonly followerState: FollowerState,
    private readonly followerAddress: `0x${string}`,
    private readonly log: Logger = logger,
  ) {}

  /**
   * Sets optional dependencies for fallback full close feature.
   * Call this after construction to enable the fallback mechanism.
   */
  setFallbackDeps(deps: ReconcilerFallbackDeps): void {
    this.fallbackDeps = deps;
    this.log.info("Fallback full close enabled");
  }

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

    // Fallback full close: check for orphaned follower positions
    if (this.fallbackDeps) {
      await this.checkAndCloseFallbackPositions(leaderPositions, followerPositions);
    }
  }

  /**
   * Checks for orphaned follower positions and closes them.
   * An orphaned position is one where the follower has a position but the leader doesn't.
   */
  private async checkAndCloseFallbackPositions(
    leaderPositions: ReadonlyMap<string, { size: number }>,
    followerPositions: ReadonlyMap<string, { size: number }>,
  ): Promise<void> {
    if (!this.fallbackDeps) return;

    for (const [coin, followerPos] of followerPositions) {
      const followerSize = followerPos.size;
      if (Math.abs(followerSize) <= EPSILON) continue;

      const leaderPos = leaderPositions.get(coin);
      const leaderSize = leaderPos?.size ?? 0;

      // Leader has no position but follower does → close follower position
      if (Math.abs(leaderSize) <= EPSILON) {
        this.log.info(`🔄 [兜底全平] 领航员无仓位但跟单者有仓位`, {
          coin,
          followerSize: followerSize.toFixed(6),
          followerNotional: "$" + (Math.abs(followerSize) * (this.fallbackDeps.metadataService.getMarkPrice(coin) ?? 0)).toFixed(2),
          reason: "定时对账发现不一致，执行兜底全平",
        });

        await this.executeFallbackClose(coin, followerSize);
      }
    }
  }

  /**
   * Executes a fallback full close for a specific coin.
   */
  private async executeFallbackClose(coin: string, followerSize: number): Promise<void> {
    if (!this.fallbackDeps) return;

    const { exchangeClient, metadataService, historyTracker, marketOrderSlippage } = this.fallbackDeps;

    try {
      const metadata = metadataService.getByCoin(coin);
      if (!metadata) {
        this.log.error(`[兜底全平] 无法获取币种元数据`, { coin });
        return;
      }

      const markPrice = metadataService.getMarkPrice(coin);
      if (!markPrice || markPrice <= 0) {
        this.log.error(`[兜底全平] 无法获取标记价格`, { coin });
        return;
      }

      // Determine action: buy to close short, sell to close long
      const isLong = followerSize > 0;
      const action = isLong ? "sell" : "buy";
      const size = Math.abs(followerSize);

      // Calculate slippage price
      const slippage = marketOrderSlippage ?? 0.05;
      const priceMultiplier = action === "buy" ? 1 + slippage : 1 - slippage;
      const limitPrice = clamp(markPrice * priceMultiplier, markPrice * 0.5, markPrice * 2);
      const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);
      const sizeStr = size.toFixed(metadata.sizeDecimals);

      this.log.info(`🔄 [兜底全平] 执行平仓`, {
        coin,
        action: action === "buy" ? "买入平空" : "卖出平多",
        size: sizeStr,
        price: "$" + priceStr,
        slippage: (slippage * 100).toFixed(1) + "%",
      });

      const order = {
        a: metadata.assetId,
        b: action === "buy",
        p: priceStr,
        s: sizeStr,
        r: true, // reduceOnly
        t: { limit: { tif: "Ioc" as const } },
        c: `0x${randomUUID().replace(/-/g, "").slice(0, 32)}`,
      };

      const response = await exchangeClient.order({
        orders: [order],
        grouping: "na",
      });

      const statuses = response.response.data.statuses;
      const errors = statuses.filter((s) => "error" in s);

      if (errors.length > 0) {
        this.log.error(`[兜底全平] 订单失败`, {
          coin,
          errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
        });
        return;
      }

      this.log.info(`✅ [兜底全平] 订单成功`, { coin, size: sizeStr });

      // Clear historical position marker if exists
      // This triggers the cleanup in historyTracker
      historyTracker.canCopy(coin, 0);

      this.log.info(`🧹 [兜底全平] 已清除历史仓位标记`, { coin });
    } catch (error) {
      this.log.error(`[兜底全平] 执行失败`, {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
