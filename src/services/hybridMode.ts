/**
 * Hybrid Mode Service for copy trading.
 *
 * Combines limit order mirroring and market order following:
 * - Subscribes to both openOrders (limit orders) and userFills (trades)
 * - Uses oid-based deduplication to avoid double-following
 * - Limit orders: mirrors with GTC limit orders (Maker fees)
 * - Market orders: follows with IOC market orders (real-time)
 *
 * Deduplication logic:
 * 1. openOrders event → record oid in trackedLimitOids → place limit order
 * 2. userFills event → check if oid is in trackedLimitOids
 *    - Yes: skip (already handled via limit order)
 *    - No: market order fill → follow with market order
 *
 * Features:
 * - 100% capture rate (both limit and market orders)
 * - Optimal fees (Maker for limits, Taker for markets)
 * - Real-time following for market orders
 * - Fill aggregation for same-oid partial fills
 */

import type * as hl from "@nktkas/hyperliquid";
import type { UserFillsEvent } from "@nktkas/hyperliquid/api/subscription";
import type { PairRiskConfig } from "../config/types.js";
import { logger, type Logger } from "../utils/logger.js";
import { EPSILON, clamp, roundToMarkPricePrecision } from "../utils/math.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import type { MarketMetadataService } from "./marketMetadata.js";
import { TradeLogger } from "../utils/tradeLogger.js";
import { randomUUID } from "node:crypto";

/** cloid prefix for identifying mirror limit orders */
const CLOID_PREFIX = "hybrid";

/**
 * Leader's open order structure from WebSocket.
 */
interface LeaderOrder {
  oid: number;
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  reduceOnly: boolean;
  timestamp: number;
}

/**
 * Order mapping between leader and follower limit orders.
 */
interface LimitOrderMapping {
  leaderOid: number;
  followerOid: number;
  cloid: string;
  coin: string;
  leaderSize: number;
  followerSize: number;
  createdAt: number;
}

/**
 * Raw fill data from Hyperliquid WebSocket.
 */
interface RawFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition: string;
  dir: string;
  oid: number;
  crossed: boolean;
}

/**
 * Pending fill group for aggregation.
 */
interface PendingFillGroup {
  oid: number;
  coin: string;
  side: "B" | "A";
  direction: string;
  fills: RawFill[];
  totalSize: number;
  totalNotional: number;
  startPosition: number;
  lastFillTime: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Dependencies for HybridModeService.
 */
export interface HybridModeDeps {
  /** Hyperliquid subscription client */
  subscriptionClient: hl.SubscriptionClient;
  /** Hyperliquid exchange client for placing orders */
  exchangeClient: hl.ExchangeClient;
  /** Hyperliquid info client for fetching state */
  infoClient: hl.InfoClient;
  /** Leader's address */
  leaderAddress: `0x${string}`;
  /** Follower's trading address */
  followerAddress: `0x${string}`;
  /** Leader state for equity calculation */
  leaderState: LeaderState;
  /** Follower state for equity and position info */
  followerState: FollowerState;
  /** Market metadata service */
  metadataService: MarketMetadataService;
  /** Risk configuration */
  risk: PairRiskConfig;
  /** Minimum order notional in USD */
  minOrderNotionalUsd: number;
  /** Historical position tracker */
  historyTracker?: HistoryPositionTracker | undefined;
  /** Fill aggregation window in ms */
  fillAggregationWindowMs?: number | undefined;
  /** Pair ID for logging */
  pairId: string;
  /** Log directory for trade logs */
  logDir?: string;
  /** Whether to enable trade logging */
  enableTradeLog?: boolean;
  /** Logger instance */
  log?: Logger;
}

/**
 * Subscription handle for cleanup.
 */
type SubscriptionHandle = {
  unsubscribe: () => Promise<void>;
};

/**
 * Hybrid Mode Service.
 *
 * Combines limit order mirroring and market order following with oid-based deduplication.
 */
export class HybridModeService {
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;
  private readonly fillAggregationWindowMs: number;
  private readonly tradeLogger: TradeLogger | null;

  // ===== State for deduplication =====

  /** Tracked limit order oids (key for deduplication) */
  private trackedLimitOids = new Set<number>();

  /** Limit order mapping: leaderOid → LimitOrderMapping */
  private limitOrderMapping = new Map<number, LimitOrderMapping>();

  /** Leader's current open orders (for change detection) */
  private leaderOrders = new Map<number, LeaderOrder>();

  /** Processed fill hashes (prevent duplicate fill processing) */
  private processedFillHashes = new Set<string>();

  /** Pending fill groups for aggregation */
  private pendingFillGroups = new Map<number, PendingFillGroup>();

  // ===== Subscriptions =====

  /** openOrders subscription handle */
  private openOrdersSub: SubscriptionHandle | null = null;

  /** userFills subscription handle */
  private userFillsSub: SubscriptionHandle | null = null;

  /** Whether the service has started */
  private started = false;

  /** Whether the initial openOrders snapshot has been received */
  private openOrdersInitialized = false;

  /** Whether the initial userFills snapshot has been received */
  private userFillsInitialized = false;

  /** Cache of leverage settings already synced */
  private readonly syncedLeverageCache = new Map<string, { leverage: number; isCross: boolean }>();

  constructor(private readonly deps: HybridModeDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd;
    this.fillAggregationWindowMs = deps.fillAggregationWindowMs ?? 500;

    // Initialize trade logger if enabled
    if (deps.enableTradeLog && deps.logDir) {
      this.tradeLogger = new TradeLogger(
        {
          logDir: deps.logDir,
          pairId: deps.pairId,
          leaderAddress: deps.leaderAddress,
          followerAddress: deps.followerAddress,
          enabled: true,
        },
        this.log,
      );
    } else {
      this.tradeLogger = null;
    }
  }

  /**
   * Starts the hybrid mode service.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.log.info("🔀 混合模式启动中（双订阅+智能去重）...", {
      pairId: this.deps.pairId,
      leaderAddress: this.deps.leaderAddress,
      fillAggregationWindowMs: this.fillAggregationWindowMs,
    });

    // 1. Recover limit order mappings from existing follower orders
    await this.recoverMappingFromExistingOrders();

    // 2. Subscribe to both openOrders and userFills
    await Promise.all([
      this.subscribeOpenOrders(),
      this.subscribeUserFills(),
    ]);

    this.started = true;
    this.log.info("🔀 混合模式已启用", {
      recoveredMappings: this.limitOrderMapping.size,
      trackedLimitOids: this.trackedLimitOids.size,
    });
  }

  /**
   * Stops the hybrid mode service.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.log.info("🔀 停止混合模式服务");

    // Clear pending aggregation timers
    for (const group of this.pendingFillGroups.values()) {
      if (group.timer) {
        clearTimeout(group.timer);
      }
    }
    this.pendingFillGroups.clear();

    // Unsubscribe
    const unsubPromises: Promise<void>[] = [];
    if (this.openOrdersSub) {
      unsubPromises.push(
        this.openOrdersSub.unsubscribe().catch((error) => {
          this.log.error("取消 openOrders 订阅失败", { error });
        }),
      );
    }
    if (this.userFillsSub) {
      unsubPromises.push(
        this.userFillsSub.unsubscribe().catch((error) => {
          this.log.error("取消 userFills 订阅失败", { error });
        }),
      );
    }

    await Promise.all(unsubPromises);
    this.openOrdersSub = null;
    this.userFillsSub = null;
    this.started = false;
  }

  // ==================== Limit Order Handling ====================

  /**
   * Recovers limit order mappings from existing follower orders.
   */
  private async recoverMappingFromExistingOrders(): Promise<void> {
    try {
      const response = await this.deps.infoClient.openOrders({
        user: this.deps.followerAddress,
      });

      let recoveredCount = 0;

      for (const order of response) {
        const leaderOid = this.parseCloid(order.cloid);

        if (leaderOid !== null) {
          this.limitOrderMapping.set(leaderOid, {
            leaderOid,
            followerOid: order.oid,
            cloid: order.cloid!,
            coin: order.coin,
            leaderSize: 0,
            followerSize: parseFloat(order.sz),
            createdAt: order.timestamp,
          });
          // Also track the oid for deduplication
          this.trackedLimitOids.add(leaderOid);
          recoveredCount++;
        }
      }

      this.log.info("🔀 [混合] 从现有挂单恢复映射", {
        totalFollowerOrders: response.length,
        recoveredMappings: recoveredCount,
      });
    } catch (error) {
      this.log.error("恢复映射失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Subscribes to leader's open orders.
   */
  private async subscribeOpenOrders(): Promise<void> {
    this.log.info("🔀 [混合] 订阅领航员 openOrders...");

    const subscription = await this.deps.subscriptionClient.openOrders(
      { user: this.deps.leaderAddress },
      async (event) => {
        await this.handleOpenOrdersUpdate(event.orders as LeaderOrder[]);
      },
    );

    this.openOrdersSub = {
      unsubscribe: () => subscription.unsubscribe(),
    };

    this.log.info("🔀 [混合] openOrders 订阅成功");
  }

  /**
   * Subscribes to leader's user fills.
   */
  private async subscribeUserFills(): Promise<void> {
    this.log.info("🔀 [混合] 订阅领航员 userFills...");

    const subscription = await this.deps.subscriptionClient.userFills(
      {
        user: this.deps.leaderAddress,
        aggregateByTime: true,
      },
      async (event) => {
        await this.handleUserFillsEvent(event);
      },
    );

    this.userFillsSub = {
      unsubscribe: () => subscription.unsubscribe(),
    };

    this.log.info("🔀 [混合] userFills 订阅成功");
  }

  /**
   * Handles openOrders update.
   */
  private async handleOpenOrdersUpdate(orders: LeaderOrder[]): Promise<void> {
    if (!this.openOrdersInitialized) {
      await this.handleOpenOrdersSnapshot(orders);
      this.openOrdersInitialized = true;
      return;
    }

    await this.detectOrderChanges(orders);
  }

  /**
   * Handles the initial openOrders snapshot.
   */
  private async handleOpenOrdersSnapshot(orders: LeaderOrder[]): Promise<void> {
    this.log.info("🔀 [混合] 收到领航员挂单快照", { count: orders.length });

    const leaderOidSet = new Set(orders.map((o) => o.oid));

    // 1. Clean up invalid mappings
    for (const [leaderOid, mapping] of this.limitOrderMapping) {
      if (!leaderOidSet.has(leaderOid)) {
        this.log.info("🔀 [混合] 清理无效映射", {
          leaderOid,
          followerOid: mapping.followerOid,
          coin: mapping.coin,
        });
        await this.cancelFollowerOrderByOid(mapping.followerOid, mapping.coin);
        this.limitOrderMapping.delete(leaderOid);
        this.trackedLimitOids.delete(leaderOid);
      }
    }

    // 2. Follow orders not yet followed
    for (const order of orders) {
      if (!this.limitOrderMapping.has(order.oid)) {
        await this.placeFollowerLimitOrder(order);
      }
      // Always track the oid for deduplication
      this.trackedLimitOids.add(order.oid);
    }

    // 3. Update cache
    this.leaderOrders = new Map(orders.map((o) => [o.oid, o]));

    this.log.info("🔀 [混合] 快照处理完成", {
      leaderOrders: this.leaderOrders.size,
      trackedOids: this.trackedLimitOids.size,
      followedOrders: this.limitOrderMapping.size,
    });
  }

  /**
   * Detects order changes.
   */
  private async detectOrderChanges(newOrders: LeaderOrder[]): Promise<void> {
    const newOrderMap = new Map(newOrders.map((o) => [o.oid, o]));
    const placePromises: Promise<void>[] = [];
    const cancelPromises: Promise<void>[] = [];

    // Detect new orders
    for (const [oid, order] of newOrderMap) {
      if (!this.leaderOrders.has(oid)) {
        this.log.info("🔀 [限价单] 领航员新增挂单", {
          coin: order.coin,
          side: order.side === "B" ? "买入" : "卖出",
          price: "$" + order.limitPx,
          size: order.sz,
          reduceOnly: order.reduceOnly,
          oid: order.oid,
        });
        // Track immediately for deduplication
        this.trackedLimitOids.add(oid);
        placePromises.push(this.placeFollowerLimitOrder(order));
      }
    }

    // Detect removed orders
    for (const [oid, order] of this.leaderOrders) {
      if (!newOrderMap.has(oid)) {
        this.log.info("🔀 [限价单] 领航员挂单消失", {
          coin: order.coin,
          oid: order.oid,
          reason: "取消或成交",
        });
        cancelPromises.push(this.cancelFollowerLimitOrder(oid));
        // Note: Don't remove from trackedLimitOids immediately
        // Keep it for a while to handle race conditions with userFills
      }
    }

    try {
      await Promise.all([...placePromises, ...cancelPromises]);
    } catch (error) {
      this.log.error("[混合] 批量处理订单变更时出错", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Collect oids to cleanup before updating leaderOrders
    const oidsToCleanup: number[] = [];
    for (const [oid] of this.leaderOrders) {
      if (!newOrderMap.has(oid)) {
        oidsToCleanup.push(oid);
      }
    }

    this.leaderOrders = newOrderMap;

    // Cleanup old tracked oids that are no longer in orders
    // Keep them for 30 seconds to handle race conditions with userFills
    if (oidsToCleanup.length > 0) {
      setTimeout(() => {
        for (const oid of oidsToCleanup) {
          if (!this.limitOrderMapping.has(oid)) {
            this.trackedLimitOids.delete(oid);
          }
        }
      }, 30000);
    }
  }

  /**
   * Places a follower limit order.
   */
  private async placeFollowerLimitOrder(leaderOrder: LeaderOrder): Promise<void> {
    if (this.limitOrderMapping.has(leaderOrder.oid)) {
      return;
    }

    // Check historical position filter
    if (this.deps.historyTracker) {
      const leaderPos = this.deps.leaderState.getPosition(leaderOrder.coin);
      const currentSize = leaderPos?.size ?? 0;
      const canCopy = this.deps.historyTracker.canCopy(leaderOrder.coin, currentSize);
      if (!canCopy) {
        this.log.debug("[混合] 跳过历史仓位的限价单", { coin: leaderOrder.coin });
        return;
      }
    }

    // Calculate follower size
    const leaderSize = parseFloat(leaderOrder.sz);
    const followerSize = this.calculateFollowerSize(leaderSize);
    const price = parseFloat(leaderOrder.limitPx);
    const notional = followerSize * price;

    // Check minimum notional
    if (notional < this.minOrderNotionalUsd) {
      this.log.debug("[混合] 限价单金额不足最小阈值，跳过", {
        coin: leaderOrder.coin,
        notional: "$" + notional.toFixed(2),
        min: "$" + this.minOrderNotionalUsd,
      });
      return;
    }

    // Get coin metadata
    const metadata = this.deps.metadataService.getByCoin(leaderOrder.coin);
    if (!metadata) {
      this.log.warn("[混合] 无法获取币种元数据", { coin: leaderOrder.coin });
      return;
    }

    // Sync leverage for new positions
    await this.syncLeverageForCoin(leaderOrder.coin);

    const cloid = this.makeCloid(leaderOrder.oid);
    const sizeStr = followerSize.toFixed(metadata.sizeDecimals);

    if (parseFloat(sizeStr) === 0) {
      this.log.debug("[混合] 数量取整后为零，跳过", { coin: leaderOrder.coin });
      return;
    }

    const order = {
      a: metadata.assetId,
      b: leaderOrder.side === "B",
      p: leaderOrder.limitPx,
      s: sizeStr,
      r: leaderOrder.reduceOnly,
      t: { limit: { tif: "Gtc" as const } },
      c: cloid,
    };

    try {
      const response = await this.deps.exchangeClient.order({
        orders: [order],
        grouping: "na",
      });

      const statuses = response.response.data.statuses;
      if (statuses.length === 0) {
        this.log.warn("[混合] 下单响应为空", { coin: leaderOrder.coin });
        return;
      }

      const status = statuses[0];

      if (status && "resting" in status) {
        const followerOid = status.resting.oid;

        this.limitOrderMapping.set(leaderOrder.oid, {
          leaderOid: leaderOrder.oid,
          followerOid,
          cloid,
          coin: leaderOrder.coin,
          leaderSize,
          followerSize,
          createdAt: Date.now(),
        });

        this.log.info("✅ [混合-限价单] 跟单挂单成功", {
          coin: leaderOrder.coin,
          side: leaderOrder.side === "B" ? "买入" : "卖出",
          price: "$" + leaderOrder.limitPx,
          leaderSize: leaderOrder.sz,
          followerSize: sizeStr,
          leaderOid: leaderOrder.oid,
          followerOid,
        });
      } else if (status && "filled" in status) {
        const filledOid = status.filled.oid;

        this.limitOrderMapping.set(leaderOrder.oid, {
          leaderOid: leaderOrder.oid,
          followerOid: filledOid,
          cloid,
          coin: leaderOrder.coin,
          leaderSize,
          followerSize,
          createdAt: Date.now(),
        });

        this.log.info("✅ [混合-限价单] 跟单挂单立即成交", {
          coin: leaderOrder.coin,
          side: leaderOrder.side === "B" ? "买入" : "卖出",
          price: "$" + leaderOrder.limitPx,
          leaderSize: leaderOrder.sz,
          followerSize: sizeStr,
        });
      } else if (status && "error" in status) {
        this.log.error("❌ [混合-限价单] 跟单挂单失败", {
          coin: leaderOrder.coin,
          error: (status as { error: string }).error,
        });
      }
    } catch (error) {
      this.log.error("❌ [混合-限价单] 跟单挂单异常", {
        coin: leaderOrder.coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cancels the follower limit order.
   */
  private async cancelFollowerLimitOrder(leaderOid: number): Promise<void> {
    const mapping = this.limitOrderMapping.get(leaderOid);
    if (!mapping) {
      return;
    }

    await this.cancelFollowerOrderByOid(mapping.followerOid, mapping.coin);
    this.limitOrderMapping.delete(leaderOid);
  }

  /**
   * Cancels a follower order by oid.
   */
  private async cancelFollowerOrderByOid(followerOid: number, coin: string): Promise<void> {
    try {
      const metadata = this.deps.metadataService.getByCoin(coin);
      if (!metadata) {
        this.log.warn("[混合] 取消挂单时无法获取币种元数据", { coin });
        return;
      }

      await this.deps.exchangeClient.cancel({
        cancels: [{ a: metadata.assetId, o: followerOid }],
      });

      this.log.info("✅ [混合] 取消跟单挂单成功", { followerOid, coin });
    } catch (error) {
      this.log.debug("[混合] 取消挂单失败（可能已成交）", {
        followerOid,
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==================== Market Order Handling (userFills) ====================

  /**
   * Handles userFills event.
   */
  private async handleUserFillsEvent(event: UserFillsEvent): Promise<void> {
    if (event.fills.length === 0) {
      return;
    }

    // Skip snapshot
    if (event.isSnapshot) {
      if (!this.userFillsInitialized) {
        this.log.info("⏭️ [混合] 跳过历史快照数据", {
          fillCount: event.fills.length,
          reason: "历史快照数据，不是实时信号",
        });
        this.userFillsInitialized = true;
      }
      return;
    }
    this.userFillsInitialized = true;

    // Update leader state incrementally
    this.deps.leaderState.handleFillEvent(event);

    // Process each fill
    for (const fill of event.fills as RawFill[]) {
      await this.processFill(fill);
    }
  }

  /**
   * Processes a single fill event.
   */
  private async processFill(fill: RawFill): Promise<void> {
    // 1. Generate fill hash for deduplication
    const fillHash = this.generateFillHash(fill);
    if (this.processedFillHashes.has(fillHash)) {
      this.log.debug("[混合] 跳过重复 fill", { fillHash });
      return;
    }
    this.processedFillHashes.add(fillHash);

    // Cleanup old hashes periodically
    if (this.processedFillHashes.size > 10000) {
      this.cleanupProcessedHashes();
    }

    // 2. Skip spot trades
    if (this.isSpotTrade(fill)) {
      this.log.debug("[混合] 跳过现货交易", { coin: fill.coin, dir: fill.dir });
      return;
    }

    // 3. Check historical position filter
    if (this.deps.historyTracker) {
      const endPosition = this.calculateEndPosition(fill);
      const canCopy = this.deps.historyTracker.canCopy(fill.coin, endPosition);
      if (!canCopy) {
        this.log.info("[混合] 跳过历史仓位操作", { coin: fill.coin, direction: fill.dir });
        return;
      }
    }

    // 4. KEY: Check if this oid is tracked as a limit order
    if (this.trackedLimitOids.has(fill.oid)) {
      // This fill is from a limit order we're already following
      // Just log and skip - our limit order will handle it
      this.log.debug("🔀 [混合-去重] 跳过限价单成交 (已有跟单限价单)", {
        coin: fill.coin,
        oid: fill.oid,
        direction: fill.dir,
        size: fill.sz,
      });
      return;
    }

    // 5. This is a market order fill - need to follow with market order
    this.log.info("🔀 [混合-市价单] 检测到市价单成交", {
      coin: fill.coin,
      oid: fill.oid,
      direction: fill.dir,
      side: fill.side === "B" ? "买入" : "卖出",
      size: fill.sz,
      price: "$" + fill.px,
      crossed: fill.crossed,
    });

    // 6. Aggregate fills by oid
    await this.aggregateFill(fill);
  }

  /**
   * Aggregates fill into pending group.
   */
  private async aggregateFill(fill: RawFill): Promise<void> {
    const group = this.pendingFillGroups.get(fill.oid);

    if (!group) {
      // Create new group
      const newGroup: PendingFillGroup = {
        oid: fill.oid,
        coin: fill.coin,
        side: fill.side,
        direction: fill.dir,
        fills: [fill],
        totalSize: parseFloat(fill.sz),
        totalNotional: parseFloat(fill.sz) * parseFloat(fill.px),
        startPosition: parseFloat(fill.startPosition),
        lastFillTime: Date.now(),
        timer: null,
      };

      newGroup.timer = setTimeout(() => {
        this.executeAggregatedMarketOrder(fill.oid);
      }, this.fillAggregationWindowMs);

      this.pendingFillGroups.set(fill.oid, newGroup);
    } else {
      // Add to existing group
      group.fills.push(fill);
      group.totalSize += parseFloat(fill.sz);
      group.totalNotional += parseFloat(fill.sz) * parseFloat(fill.px);
      group.lastFillTime = Date.now();

      // Reset timer (sliding window)
      if (group.timer) {
        clearTimeout(group.timer);
      }
      group.timer = setTimeout(() => {
        this.executeAggregatedMarketOrder(fill.oid);
      }, this.fillAggregationWindowMs);
    }
  }

  /**
   * Executes aggregated market order.
   */
  private async executeAggregatedMarketOrder(oid: number): Promise<void> {
    const group = this.pendingFillGroups.get(oid);
    if (!group) {
      return;
    }

    this.pendingFillGroups.delete(oid);

    const avgPrice = group.totalNotional / group.totalSize;

    this.log.info("🔀 [混合-市价单] 聚合完成，执行跟单", {
      coin: group.coin,
      oid: group.oid,
      fillCount: group.fills.length,
      totalSize: group.totalSize.toFixed(6),
      avgPrice: "$" + avgPrice.toFixed(2),
      direction: group.direction,
    });

    // Refresh states
    await this.refreshStates();

    // Update trade logger
    const leaderEquity = this.deps.leaderState.getMetrics().accountValueUsd;
    const followerEquity = this.deps.followerState.getMetrics().accountValueUsd;
    this.tradeLogger?.updateEquity(leaderEquity, followerEquity);

    // Execute market order following
    await this.executeMarketOrderFollow(group, avgPrice);
  }

  /**
   * Executes market order following.
   */
  private async executeMarketOrderFollow(
    group: PendingFillGroup,
    avgPrice: number,
  ): Promise<void> {
    const { coin, direction, totalSize, side, startPosition } = group;

    // Calculate follower size
    const leaderEquity = this.deps.leaderState.getMetrics().accountValueUsd;
    const followerEquity = this.deps.followerState.getMetrics().accountValueUsd;

    if (leaderEquity <= 0 || followerEquity <= 0) {
      this.log.warn("[混合] 资产为零，跳过", { leaderEquity, followerEquity });
      return;
    }

    const fundRatio = followerEquity / leaderEquity;
    const copyRatio = this.deps.risk.copyRatio ?? 1;
    let followerSize = totalSize * fundRatio * copyRatio;

    // Calculate notional
    let notional = followerSize * avgPrice;

    // Determine if opening or closing
    const isOpening = this.isOpeningDirection(direction);
    const endPosition = this.calculateEndPositionFromGroup(group);
    const isNewPosition = Math.abs(startPosition) < EPSILON;
    const isFullClose = Math.abs(endPosition) < EPSILON;

    // Boost target
    const boostTargetNotional = this.minOrderNotionalUsd + 1;

    // Apply boost/skip logic (similar to signalProcessor)
    if (isOpening) {
      if (notional < this.minOrderNotionalUsd) {
        const isNewOrReversal = isNewPosition ||
          direction === "Long > Short" ||
          direction === "Short > Long";

        if (!isNewOrReversal) {
          // Add position: check price
          const markPrice = this.deps.metadataService.getMarkPrice(coin) ?? avgPrice;
          const priceDiff = (markPrice - avgPrice) / avgPrice;
          const threshold = this.deps.risk.boostPriceThreshold ?? 0.0005;

          const isLong = direction === "Open Long";
          const priceUnfavorable = isLong ? (priceDiff > threshold) : (priceDiff < -threshold);

          if (priceUnfavorable) {
            this.log.info("⏭️ [混合] 跳过不利价格的加仓", {
              coin,
              direction,
              leaderPrice: "$" + avgPrice.toFixed(4),
              currentPrice: "$" + markPrice.toFixed(4),
              priceDiff: (priceDiff * 100).toFixed(4) + "%",
            });
            this.tradeLogger?.logTradeSkipped(coin, `加仓价格不利(${(priceDiff * 100).toFixed(2)}%)`);
            return;
          }
        }

        followerSize = boostTargetNotional / avgPrice;
        notional = boostTargetNotional;
        this.log.info("📈 [混合] 提升开仓到最小金额", {
          coin,
          boostedNotional: "$" + notional.toFixed(2),
        });
      }
    } else {
      // Close position: no threshold
      if (notional < this.minOrderNotionalUsd) {
        this.log.info("📉 [混合] 执行低于阈值的减仓", {
          coin,
          notional: "$" + notional.toFixed(2),
          reason: "减仓免阈值",
        });
      }
    }

    // Determine action
    const action = this.determineAction(
      direction,
      coin,
      avgPrice,
      followerSize,
      isFullClose,
      startPosition,
      totalSize,
    );

    if (!action) {
      this.log.debug("[混合] 无法确定交易动作", { coin, direction });
      this.tradeLogger?.logTradeSkipped(coin, "无法确定交易动作");
      return;
    }

    // Sync leverage if new position
    if (isNewPosition) {
      await this.syncLeverageForCoin(coin);
    }

    // Execute
    await this.executeMarketOrder(action);
  }

  /**
   * Determines the trading action.
   */
  private determineAction(
    direction: string,
    coin: string,
    price: number,
    followerSize: number,
    isFullClose: boolean,
    leaderStartPos: number,
    leaderReduceSize: number,
  ): { coin: string; action: "buy" | "sell"; size: number; reduceOnly: boolean; description: string } | null {
    const followerPos = this.deps.followerState.getPosition(coin);
    const currentFollowerSize = followerPos?.size ?? 0;

    let action: "buy" | "sell";
    let reduceOnly = false;
    let actualSize = followerSize;
    let description: string;

    switch (direction) {
      case "Open Long":
        action = "buy";
        description = Math.abs(leaderStartPos) < EPSILON ? "🟢 新开多仓" : "🟢 加多仓";
        break;

      case "Open Short":
        action = "sell";
        description = Math.abs(leaderStartPos) < EPSILON ? "🔴 新开空仓" : "🔴 加空仓";
        break;

      case "Close Long":
        reduceOnly = true;
        action = "sell";

        if (currentFollowerSize <= 0) {
          this.log.debug("[混合] 无多仓可减", { coin, currentFollowerSize });
          return null;
        }

        const leaderLongStartPos = Math.abs(leaderStartPos);
        const leaderLongReduceRatio = leaderLongStartPos > EPSILON
          ? leaderReduceSize / leaderLongStartPos
          : 1;

        if (isFullClose || leaderLongReduceRatio >= 0.99) {
          actualSize = currentFollowerSize;
          description = "⬜ 平多仓";
        } else {
          actualSize = currentFollowerSize * leaderLongReduceRatio;
          description = "🟡 减多仓";
        }
        break;

      case "Close Short":
        reduceOnly = true;
        action = "buy";

        if (currentFollowerSize >= 0) {
          this.log.debug("[混合] 无空仓可减", { coin, currentFollowerSize });
          return null;
        }

        const absFollowerSize = Math.abs(currentFollowerSize);
        const leaderShortStartPos = Math.abs(leaderStartPos);
        const leaderShortReduceRatio = leaderShortStartPos > EPSILON
          ? leaderReduceSize / leaderShortStartPos
          : 1;

        if (isFullClose || leaderShortReduceRatio >= 0.99) {
          actualSize = absFollowerSize;
          description = "⬜ 平空仓";
        } else {
          actualSize = absFollowerSize * leaderShortReduceRatio;
          description = "🟡 减空仓";
        }
        break;

      case "Long > Short":
        action = "sell";
        if (currentFollowerSize > EPSILON) {
          actualSize = currentFollowerSize + followerSize;
          description = "🔄 反向：多转空";
        } else if (currentFollowerSize < -EPSILON) {
          actualSize = followerSize;
          description = "🔴 加空仓";
        } else {
          actualSize = followerSize;
          description = "🔴 新开空仓";
        }
        break;

      case "Short > Long":
        action = "buy";
        if (currentFollowerSize < -EPSILON) {
          actualSize = Math.abs(currentFollowerSize) + followerSize;
          description = "🔄 反向：空转多";
        } else if (currentFollowerSize > EPSILON) {
          actualSize = followerSize;
          description = "🟢 加多仓";
        } else {
          actualSize = followerSize;
          description = "🟢 新开多仓";
        }
        break;

      default:
        this.log.warn("[混合] 未知方向", { direction });
        return null;
    }

    return { coin, action, size: actualSize, reduceOnly, description };
  }

  /**
   * Executes a market order (IOC).
   */
  private async executeMarketOrder(action: {
    coin: string;
    action: "buy" | "sell";
    size: number;
    reduceOnly: boolean;
    description: string;
  }): Promise<void> {
    const metadata = this.deps.metadataService.getByCoin(action.coin);
    if (!metadata) {
      this.log.error("[混合] 无元数据", { coin: action.coin });
      return;
    }

    await this.deps.metadataService.refreshMidPrices();

    const executionPrice = this.deps.metadataService.getExecutionPrice(action.coin);
    const markPrice = this.deps.metadataService.getMarkPrice(action.coin);
    if (!executionPrice || !markPrice) {
      this.log.error("[混合] 无法获取价格", { coin: action.coin });
      return;
    }

    const slippage = this.deps.risk.marketOrderSlippage ?? 0.05;
    const priceMultiplier = action.action === "buy" ? 1 + slippage : 1 - slippage;
    const limitPrice = clamp(executionPrice * priceMultiplier, executionPrice * 0.5, executionPrice * 2);
    const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);
    const sizeStr = action.size.toFixed(metadata.sizeDecimals);

    if (parseFloat(sizeStr) === 0) {
      this.log.debug("[混合] 数量取整为零", { coin: action.coin });
      return;
    }

    const notional = action.size * executionPrice;

    this.log.info(`${action.description}`, {
      coin: action.coin,
      action: action.action === "buy" ? "买入" : "卖出",
      size: sizeStr,
      notional: "$" + notional.toFixed(2),
      midPrice: "$" + executionPrice.toFixed(2),
      slippage: (slippage * 100).toFixed(1) + "%",
      reduceOnly: action.reduceOnly,
      orderType: "Ioc(市价)",
    });

    const order = {
      a: metadata.assetId,
      b: action.action === "buy",
      p: priceStr,
      s: sizeStr,
      r: action.reduceOnly,
      t: { limit: { tif: "Ioc" as const } },
      c: `0x${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    };

    try {
      const response = await this.deps.exchangeClient.order({
        orders: [order],
        grouping: "na",
      });

      const statuses = response.response.data.statuses;
      const filled = statuses.filter((s) => "filled" in s || "resting" in s);
      const errors = statuses.filter((s) => "error" in s);

      if (filled.length > 0) {
        this.log.info("✅ [混合-市价单] 执行成功", { coin: action.coin });
        this.tradeLogger?.logTradeSuccess(action as any);
      }
      if (errors.length > 0) {
        const errorMsg = errors.map((e) => ("error" in e ? e.error : "unknown")).join(", ");
        this.log.warn("❌ [混合-市价单] 执行失败", { coin: action.coin, errors: errorMsg });
        this.tradeLogger?.logTradeFailed(action as any, errorMsg);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log.error("[混合-市价单] 执行异常", { coin: action.coin, error: errorMessage });
      this.tradeLogger?.logTradeFailed(action as any, errorMessage);
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Calculates follower size based on fund ratio.
   */
  private calculateFollowerSize(leaderSize: number): number {
    const leaderEquity = this.deps.leaderState.getMetrics().accountValueUsd;
    const followerEquity = this.deps.followerState.getMetrics().accountValueUsd;

    if (leaderEquity <= EPSILON || followerEquity <= EPSILON) {
      return 0;
    }

    const fundRatio = followerEquity / leaderEquity;
    const copyRatio = this.deps.risk.copyRatio;

    return leaderSize * fundRatio * copyRatio;
  }

  /**
   * Creates a cloid that encodes the leader's oid.
   */
  private makeCloid(leaderOid: number): string {
    const prefixHex = Buffer.from(CLOID_PREFIX).toString("hex");
    const oidHex = leaderOid.toString(16).padStart(16, "0");
    return `0x${prefixHex}${oidHex}`.slice(0, 34);
  }

  /**
   * Parses a cloid to extract leader's oid.
   */
  private parseCloid(cloid: string | null | undefined): number | null {
    if (!cloid) return null;

    try {
      const prefixHex = Buffer.from(CLOID_PREFIX).toString("hex");
      const expectedPrefix = `0x${prefixHex}`;

      if (!cloid.startsWith(expectedPrefix)) {
        return null;
      }

      const oidHex = cloid.slice(expectedPrefix.length);
      return parseInt(oidHex, 16);
    } catch {
      return null;
    }
  }

  /**
   * Generates a unique hash for a fill.
   */
  private generateFillHash(fill: RawFill): string {
    return `${fill.oid}-${fill.time}-${fill.sz}-${fill.px}`;
  }

  /**
   * Cleans up old processed fill hashes.
   */
  private cleanupProcessedHashes(): void {
    // Keep only recent 5000
    if (this.processedFillHashes.size > 5000) {
      const arr = Array.from(this.processedFillHashes);
      this.processedFillHashes = new Set(arr.slice(-5000));
    }
  }

  /**
   * Checks if a fill is a spot trade.
   */
  private isSpotTrade(fill: RawFill): boolean {
    if (fill.coin.startsWith("@")) {
      return true;
    }
    const perpDirections = [
      "Open Long",
      "Close Long",
      "Open Short",
      "Close Short",
      "Long > Short",
      "Short > Long",
    ];
    return !perpDirections.includes(fill.dir);
  }

  /**
   * Checks if direction is an opening action.
   */
  private isOpeningDirection(direction: string): boolean {
    switch (direction) {
      case "Open Long":
      case "Open Short":
      case "Long > Short":
      case "Short > Long":
        return true;
      case "Close Long":
      case "Close Short":
        return false;
      default:
        return true;
    }
  }

  /**
   * Calculates end position from a single fill.
   */
  private calculateEndPosition(fill: RawFill): number {
    const startPos = parseFloat(fill.startPosition);
    const size = parseFloat(fill.sz);
    const isBuy = fill.side === "B";
    return isBuy ? startPos + size : startPos - size;
  }

  /**
   * Calculates end position from fill group.
   */
  private calculateEndPositionFromGroup(group: PendingFillGroup): number {
    let pos = group.startPosition;
    for (const fill of group.fills) {
      const size = parseFloat(fill.sz);
      const isBuy = fill.side === "B";
      pos = isBuy ? pos + size : pos - size;
    }
    return pos;
  }

  /**
   * Refreshes leader and follower states.
   */
  private async refreshStates(): Promise<void> {
    try {
      const [leaderState, followerState] = await Promise.all([
        this.deps.infoClient.clearinghouseState({ user: this.deps.leaderAddress }),
        this.deps.infoClient.clearinghouseState({ user: this.deps.followerAddress }),
      ]);
      this.deps.leaderState.applyClearinghouseState(leaderState);
      this.deps.followerState.applyClearinghouseState(followerState);
    } catch (error) {
      this.log.warn("[混合] 刷新状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Syncs leverage for a coin.
   */
  private async syncLeverageForCoin(coin: string): Promise<void> {
    const leaderPos = this.deps.leaderState.getPosition(coin);
    if (!leaderPos || leaderPos.leverage <= 0) {
      return;
    }

    const metadata = this.deps.metadataService.getByCoin(coin);
    if (!metadata) {
      return;
    }

    const leverage = Math.floor(leaderPos.leverage);
    const isCross = leaderPos.leverageType === "cross";

    const cached = this.syncedLeverageCache.get(coin);
    if (cached && cached.leverage === leverage && cached.isCross === isCross) {
      return;
    }

    try {
      this.log.info("[混合] 同步杠杆", { coin, leverage, mode: isCross ? "cross" : "isolated" });
      await this.deps.exchangeClient.updateLeverage({
        asset: metadata.assetId,
        isCross,
        leverage,
      });
      this.syncedLeverageCache.set(coin, { leverage, isCross });
    } catch (error) {
      this.log.warn("[混合] 同步杠杆失败", {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
