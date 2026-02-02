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
 * - **Limit order cleanup**: Cancel orphaned limit orders when leader has no position
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
  /**
   * 是否启用智能订单模式
   * 启用时会在对账时清理孤立的限价单（领航员无仓位时取消跟单者该币种的限价单）
   */
  enableSmartOrder?: boolean;
  /**
   * 减仓限价单超时时间（毫秒）
   * 超时后取消限价单并执行市价减仓
   * 设为 0 禁用超时检查
   * @default 180000 (3分钟)
   */
  reduceOrderTimeoutMs?: number;
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

      // Smart order mode: cleanup orphaned limit orders
      if (this.fallbackDeps.enableSmartOrder) {
        await this.cleanupOrphanedLimitOrders(leaderPositions);
        
        // Cleanup timed-out reduce orders (and execute market order fallback)
        await this.cleanupTimedOutReduceOrders(followerPositions);
      }
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
   * Cleans up orphaned limit orders (Smart Order Mode).
   * Cancels follower's limit orders for coins where leader has no position.
   */
  private async cleanupOrphanedLimitOrders(
    leaderPositions: ReadonlyMap<string, { size: number }>,
  ): Promise<void> {
    if (!this.fallbackDeps) return;

    const { exchangeClient, metadataService } = this.fallbackDeps;

    try {
      // Get follower's open orders
      const openOrders = await this.infoClient.openOrders({ user: this.followerAddress });

      if (!openOrders || openOrders.length === 0) {
        return;
      }

      // Find orders for coins where leader has no position
      const ordersToCancel: Array<{ a: number; o: number }> = [];

      for (const order of openOrders) {
        const coin = order.coin;
        const leaderPos = leaderPositions.get(coin);
        const leaderSize = leaderPos?.size ?? 0;

        // Leader has no position for this coin → cancel the limit order
        if (Math.abs(leaderSize) <= EPSILON) {
          const metadata = metadataService.getByCoin(coin);
          if (metadata) {
            ordersToCancel.push({ a: metadata.assetId, o: order.oid });
            this.log.info(`🧹 [限价单清理] 准备取消孤立限价单`, {
              coin,
              oid: order.oid,
              side: order.side === "B" ? "买" : "卖",
              size: order.sz,
              price: "$" + order.limitPx,
              reason: "领航员已无该币种仓位",
            });
          }
        }
      }

      // Cancel orders in batch
      if (ordersToCancel.length > 0) {
        try {
          const response = await exchangeClient.cancel({ cancels: ordersToCancel });

          const statuses = response.response.data.statuses;
          const successCount = statuses.filter((s) => s === "success").length;
          const errorCount = statuses.length - successCount;

          this.log.info(`✅ [限价单清理] 取消完成`, {
            total: ordersToCancel.length,
            success: successCount,
            failed: errorCount,
          });

          if (errorCount > 0) {
            const errors = statuses.filter((s) => s !== "success");
            this.log.warn(`⚠️ [限价单清理] 部分取消失败`, { errors });
          }
        } catch (cancelError) {
          this.log.error(`[限价单清理] 取消订单失败`, {
            error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          });
        }
      }
    } catch (error) {
      this.log.error(`[限价单清理] 获取未成交订单失败`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cleans up timed-out reduce orders and executes market order fallback.
   * 
   * 减仓限价单超时处理：
   * 1. 获取所有未成交订单
   * 2. 过滤出减仓订单（side 与仓位方向相反）
   * 3. 检查是否超时
   * 4. 超时则取消订单并执行市价减仓
   * 
   * 判断减仓订单的逻辑：
   * - 多仓（size > 0）+ 卖单（side = A）= 减仓
   * - 空仓（size < 0）+ 买单（side = B）= 减仓
   */
  private async cleanupTimedOutReduceOrders(
    followerPositions: ReadonlyMap<string, { size: number }>,
  ): Promise<void> {
    if (!this.fallbackDeps) return;

    const timeoutMs = this.fallbackDeps.reduceOrderTimeoutMs ?? 180_000;  // 默认 3 分钟
    
    // 超时时间为 0 表示禁用
    if (timeoutMs <= 0) return;

    const { exchangeClient, metadataService } = this.fallbackDeps;
    const now = Date.now();

    try {
      // 获取跟单者所有未成交订单
      const openOrders = await this.infoClient.openOrders({ user: this.followerAddress });

      if (!openOrders || openOrders.length === 0) {
        return;
      }

      // 遍历订单，检查是否为超时的减仓订单
      for (const order of openOrders) {
        const coin = order.coin;
        const followerPos = followerPositions.get(coin);
        const followerSize = followerPos?.size ?? 0;

        // 判断是否为减仓订单
        // 多仓（size > 0）+ 卖单（side = A）= 减仓
        // 空仓（size < 0）+ 买单（side = B）= 减仓
        const isLong = followerSize > EPSILON;
        const isShort = followerSize < -EPSILON;
        const isSellOrder = order.side === "A";
        const isBuyOrder = order.side === "B";
        
        const isReduceOrder = (isLong && isSellOrder) || (isShort && isBuyOrder);
        
        if (!isReduceOrder) {
          continue;  // 不是减仓订单，跳过
        }

        // 检查订单是否超时
        const orderAge = now - order.timestamp;
        if (orderAge < timeoutMs) {
          continue;  // 未超时，跳过
        }

        const orderAgeMinutes = (orderAge / 60_000).toFixed(1);
        const timeoutMinutes = (timeoutMs / 60_000).toFixed(1);

        this.log.info(`⏰ [减仓超时] 发现超时的减仓限价单`, {
          coin,
          oid: order.oid,
          side: isSellOrder ? "卖" : "买",
          size: order.sz,
          price: "$" + order.limitPx,
          orderAge: orderAgeMinutes + "分钟",
          timeout: timeoutMinutes + "分钟",
        });

        // 1. 取消超时订单
        const metadata = metadataService.getByCoin(coin);
        if (!metadata) {
          this.log.warn(`[减仓超时] 无法获取币种元数据，跳过`, { coin });
          continue;
        }

        try {
          await exchangeClient.cancel({
            cancels: [{ a: metadata.assetId, o: order.oid }],
          });
          this.log.info(`✅ [减仓超时] 已取消超时限价单`, {
            coin,
            oid: order.oid,
          });
        } catch (cancelError) {
          this.log.error(`[减仓超时] 取消订单失败`, {
            coin,
            oid: order.oid,
            error: cancelError instanceof Error ? cancelError.message : String(cancelError),
          });
          continue;  // 取消失败，跳过市价补单
        }

        // 2. 执行市价减仓补单
        const orderSize = parseFloat(order.sz);
        await this.executeMarketReduceFallback(coin, orderSize, isSellOrder ? "sell" : "buy");
      }
    } catch (error) {
      this.log.error(`[减仓超时] 检查超时订单失败`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Executes a market order to fulfill a timed-out reduce order.
   * 
   * @param coin - The coin symbol
   * @param size - The order size
   * @param action - "buy" or "sell"
   */
  private async executeMarketReduceFallback(
    coin: string,
    size: number,
    action: "buy" | "sell",
  ): Promise<void> {
    if (!this.fallbackDeps) return;

    const { exchangeClient, metadataService, marketOrderSlippage } = this.fallbackDeps;

    try {
      const metadata = metadataService.getByCoin(coin);
      if (!metadata) {
        this.log.error(`[减仓超时] 无法获取币种元数据`, { coin });
        return;
      }

      const markPrice = metadataService.getMarkPrice(coin);
      if (!markPrice || markPrice <= 0) {
        this.log.error(`[减仓超时] 无法获取标记价格`, { coin });
        return;
      }

      // 计算滑点价格
      const slippage = marketOrderSlippage ?? 0.05;
      const priceMultiplier = action === "buy" ? 1 + slippage : 1 - slippage;
      const limitPrice = clamp(markPrice * priceMultiplier, markPrice * 0.5, markPrice * 2);
      const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);
      const sizeStr = size.toFixed(metadata.sizeDecimals);

      this.log.info(`🔄 [减仓超时] 执行市价减仓补单`, {
        coin,
        action: action === "buy" ? "买入" : "卖出",
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
        this.log.error(`[减仓超时] 市价减仓失败`, {
          coin,
          errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
        });
        return;
      }

      this.log.info(`✅ [减仓超时] 市价减仓成功`, { coin, size: sizeStr });
    } catch (error) {
      this.log.error(`[减仓超时] 执行市价减仓异常`, {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
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
