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
 * - **Position aggregation mode**: Batch sync add/reduce position signals
 *
 * The fallback full close ensures position consistency even when WebSocket signals are lost.
 */

import type * as hl from "@nktkas/hyperliquid";
import type { CopyTradingConfig } from "../config/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import type { PositionSnapshot } from "../domain/types.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import type { MarketMetadataService } from "./marketMetadata.js";
import { clamp } from "../utils/math.js";
import { randomUUID } from "node:crypto";

/** Default reconciliation interval: 5 minutes (reduced from 1 minute) */
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum position size to consider non-zero */
const EPSILON = 1e-9;

/**
 * Determines the number of decimal places in a number's string representation.
 */
function getDecimalPlaces(value: number): number {
  const str = value.toString();
  const decimalIndex = str.indexOf(".");
  if (decimalIndex === -1) return 0;
  return str.length - decimalIndex - 1;
}

/**
 * Rounds a price to match the precision of a reference price.
 */
function roundToMarkPricePrecision(price: number, markPrice: number): string {
  const decimals = getDecimalPlaces(markPrice);
  let result = price.toFixed(decimals);
  if (decimals > 0) {
    result = result.replace(/\.?0+$/, "");
  }
  return result || "0";
}

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
 * Aggregation mode configuration.
 * 
 * 聚合模式下只执行加仓同步，不执行减仓同步。
 * 减仓通过以下方式触发：
 * 1. 实时信号（领航员发出 Close Long/Close Short）
 * 2. 兜底全平（领航员无仓位但跟单者有仓位）
 */
export interface AggregationConfig {
  /** Whether aggregation mode is enabled */
  enabled: boolean;
  /** Copy ratio for position sizing */
  copyRatio: number;
  /** Minimum order notional in USD */
  minOrderNotionalUsd: number;
}

/**
 * Manages periodic reconciliation of leader and follower states.
 * Also performs fallback full close when leader has no position but follower does.
 * 
 * In aggregation mode, also handles batch syncing of add/reduce position signals.
 */
export class Reconciler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private fallbackDeps: ReconcilerFallbackDeps | null = null;
  
  /** Aggregation mode configuration */
  private aggregationConfig: AggregationConfig | null = null;

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
   * Enables aggregation mode for batch syncing add/reduce position signals.
   * Call this after construction if aggregation mode is needed.
   */
  enableAggregationMode(config: AggregationConfig): void {
    this.aggregationConfig = config;
    this.log.info("📦 仓位聚合模式已启用（对账器）", {
      copyRatio: config.copyRatio,
      minOrderNotionalUsd: "$" + config.minOrderNotionalUsd,
      加仓: "对账周期批量同步",
      减仓: "仅通过实时信号或兜底全平",
    });
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

    // Aggregation mode: sync position differences
    if (this.aggregationConfig?.enabled && this.fallbackDeps) {
      await this.syncPositionDifferences();
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

  // ==================== 仓位聚合模式：差异同步 ====================

  /**
   * Syncs position differences between leader and follower.
   * Only called when aggregation mode is enabled.
   */
  private async syncPositionDifferences(): Promise<void> {
    if (!this.aggregationConfig || !this.fallbackDeps) return;

    const leaderPositions = this.leaderState.getPositions();
    const followerPositions = this.followerState.getPositions();
    const leaderEquity = this.leaderState.getMetrics().accountValueUsd;
    const followerEquity = this.followerState.getMetrics().accountValueUsd;

    if (leaderEquity <= 0 || followerEquity <= 0) {
      this.log.warn("[聚合同步] 账户资产异常，跳过同步", {
        leaderEquity: "$" + leaderEquity.toFixed(2),
        followerEquity: "$" + followerEquity.toFixed(2),
      });
      return;
    }

    const fundRatio = followerEquity / leaderEquity;

    // Check each leader position for sync needs
    if (leaderPositions.size === 0) {
      this.log.debug("[聚合同步] 领航员无持仓，跳过同步");
      return;
    }

    this.log.debug("[聚合同步] 开始检查仓位差异", {
      leaderPositionCount: leaderPositions.size,
      followerPositionCount: followerPositions.size,
      fundRatio: fundRatio.toFixed(6),
    });

    for (const [coin, leaderPos] of leaderPositions) {
      const followerPos = followerPositions.get(coin);
      
      await this.syncSinglePosition(
        coin,
        leaderPos as PositionSnapshot,
        followerPos as PositionSnapshot | undefined,
        fundRatio,
      );
    }
  }

  /**
   * Syncs a single position between leader and follower.
   */
  private async syncSinglePosition(
    coin: string,
    leaderPos: PositionSnapshot,
    followerPos: PositionSnapshot | undefined,
    fundRatio: number,
  ): Promise<void> {
    if (!this.aggregationConfig || !this.fallbackDeps) return;

    const leaderSize = leaderPos.size;
    const followerSize = followerPos?.size ?? 0;

    // Skip if leader has no position (handled by fallback full close)
    if (Math.abs(leaderSize) <= EPSILON) {
      return;
    }

    // Calculate target size for follower
    const targetSize = leaderSize * fundRatio * this.aggregationConfig.copyRatio;
    const sizeDiff = targetSize - followerSize;

    // Skip if difference is negligible
    if (Math.abs(sizeDiff) <= EPSILON) {
      return;
    }

    const markPrice = this.fallbackDeps.metadataService.getMarkPrice(coin);
    if (!markPrice || markPrice <= 0) {
      return;
    }

    const diffNotional = Math.abs(sizeDiff) * markPrice;

    // Skip if notional is below minimum
    if (diffNotional < this.aggregationConfig.minOrderNotionalUsd) {
      this.log.debug(`[聚合同步] 差异金额不足最小阈值，跳过`, {
        coin,
        diffNotional: "$" + diffNotional.toFixed(2),
        minNotional: "$" + this.aggregationConfig.minOrderNotionalUsd,
      });
      return;
    }

    // Determine if this is add position or reduce position
    // Add position: sizeDiff and leaderSize have same sign
    // Reduce position: sizeDiff and leaderSize have opposite signs
    const isAddPosition = Math.sign(sizeDiff) === Math.sign(leaderSize);

    // 聚合模式下只执行加仓同步，不执行减仓同步
    // 理由：
    // 1. 减仓应该跟随领航员的实际操作（实时信号），不应因 equity 波动触发
    // 2. equity 波动可能导致 targetSize 变小，触发不合理的减仓
    // 3. 完全平仓会立即执行（不受聚合模式影响）
    // 4. 兜底全平会处理领航员平仓后的清理
    if (!isAddPosition) {
      this.log.debug(`[聚合同步] 跳过减仓（等待领航员实际操作）`, {
        coin,
        followerSize: followerSize.toFixed(6),
        targetSize: targetSize.toFixed(6),
        reason: "聚合模式下减仓仅通过实时信号或兜底全平执行",
      });
      return;
    }

    this.log.info(`📊 [聚合同步] 检测到仓位差异，需要加仓`, {
      coin,
      leaderSize: leaderSize.toFixed(6),
      followerSize: followerSize.toFixed(6),
      targetSize: targetSize.toFixed(6),
      sizeDiff: sizeDiff.toFixed(6),
      diffNotional: "$" + diffNotional.toFixed(2),
    });

    await this.executeAggregationAddPosition(coin, sizeDiff, leaderPos, markPrice);
  }

  /**
   * Executes an add position order.
   * 
   * 加仓不检查价格，直接执行。
   * 理由：
   * 1. 聚合模式的目标是保持仓位比例一致，不是优化入场价格
   * 2. 领航员的均价是多次交易的累积结果，不适合作为加仓的价格参考
   * 3. 延迟是不可避免的，严格的价格检查会导致仓位永远无法同步
   */
  private async executeAggregationAddPosition(
    coin: string,
    sizeDiff: number,
    leaderPos: PositionSnapshot,
    _markPrice: number,
  ): Promise<void> {
    if (!this.aggregationConfig || !this.fallbackDeps) return;

    // Execute the add position directly (no price check)
    const isLong = leaderPos.size > 0;
    const action = isLong ? "buy" : "sell";
    await this.executePositionAdjust(coin, Math.abs(sizeDiff), action, false, "加仓");
  }

  /**
   * Executes a position adjustment order.
   * Reuses the order execution logic from fallback close.
   */
  private async executePositionAdjust(
    coin: string,
    size: number,
    action: "buy" | "sell",
    reduceOnly: boolean,
    actionType: string,
  ): Promise<void> {
    if (!this.fallbackDeps) return;

    const { exchangeClient, metadataService, marketOrderSlippage } = this.fallbackDeps;

    try {
      const metadata = metadataService.getByCoin(coin);
      if (!metadata) {
        this.log.error(`[聚合同步] 无法获取币种元数据`, { coin });
        return;
      }

      const markPrice = metadataService.getMarkPrice(coin);
      if (!markPrice || markPrice <= 0) {
        this.log.error(`[聚合同步] 无法获取标记价格`, { coin });
        return;
      }

      // Calculate slippage price
      const slippage = marketOrderSlippage ?? 0.05;
      const priceMultiplier = action === "buy" ? 1 + slippage : 1 - slippage;
      const limitPrice = clamp(markPrice * priceMultiplier, markPrice * 0.5, markPrice * 2);
      const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);
      const sizeStr = size.toFixed(metadata.sizeDecimals);

      // Skip if size rounds to zero
      if (parseFloat(sizeStr) === 0) {
        this.log.debug(`[聚合同步] 数量取整后为零，跳过`, { coin });
        return;
      }

      const notional = size * markPrice;

      this.log.info(`📦 [聚合同步] 执行${actionType}`, {
        coin,
        action: action === "buy" ? "买入" : "卖出",
        size: sizeStr,
        notional: "$" + notional.toFixed(2),
        price: "$" + priceStr,
        slippage: (slippage * 100).toFixed(1) + "%",
        reduceOnly,
      });

      const order = {
        a: metadata.assetId,
        b: action === "buy",
        p: priceStr,
        s: sizeStr,
        r: reduceOnly,
        t: { limit: { tif: "Ioc" as const } },
        c: `0x${randomUUID().replace(/-/g, "").slice(0, 32)}`,
      };

      const response = await exchangeClient.order({
        orders: [order],
        grouping: "na",
      });

      const statuses = response.response.data.statuses;
      const filled = statuses.filter((s) => "filled" in s || "resting" in s);
      const errors = statuses.filter((s) => "error" in s);

      if (filled.length > 0) {
        this.log.info(`✅ [聚合同步] ${actionType}订单成功`, { coin, size: sizeStr });
      }
      if (errors.length > 0) {
        this.log.warn(`❌ [聚合同步] ${actionType}订单失败`, {
          coin,
          errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
        });
      }
    } catch (error) {
      this.log.error(`[聚合同步] ${actionType}执行失败`, {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
