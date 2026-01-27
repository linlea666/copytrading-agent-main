/**
 * Order Mirror Service for copy trading.
 *
 * Monitors leader's open orders (limit orders) and mirrors them for the follower.
 * This mode uses GTC limit orders instead of IOC market orders, resulting in
 * lower trading fees (Maker rate instead of Taker rate).
 *
 * Features:
 * - Subscribe to leader's openOrders WebSocket
 * - Mirror new limit orders with the same price
 * - Cancel follower orders when leader cancels
 * - Recover order mappings from existing orders on restart (via cloid)
 *
 * Note: This mode only captures limit orders. Market orders are not visible
 * in the openOrders feed and will be missed.
 */

import type * as hl from "@nktkas/hyperliquid";
import type { PairRiskConfig } from "../config/types.js";
import { logger, type Logger } from "../utils/logger.js";
import { EPSILON } from "../utils/math.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import type { MarketMetadataService } from "./marketMetadata.js";

/** cloid prefix for identifying mirror orders */
const CLOID_PREFIX = "mirror";

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
 * Order mapping between leader and follower orders.
 */
interface OrderMapping {
  leaderOid: number;
  followerOid: number;
  cloid: string;
  coin: string;
  leaderSize: number;
  followerSize: number;
  createdAt: number;
}

/**
 * Dependencies for OrderMirrorService.
 */
export interface OrderMirrorDeps {
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
  /** Follower state for equity calculation */
  followerState: FollowerState;
  /** Market metadata service */
  metadataService: MarketMetadataService;
  /** Risk configuration */
  risk: PairRiskConfig;
  /** Minimum order notional in USD */
  minOrderNotionalUsd: number;
  /** Pair ID for logging */
  pairId: string;
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
 * Order Mirror Service.
 *
 * Mirrors leader's limit orders for the follower using GTC limit orders.
 */
export class OrderMirrorService {
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;

  /** Leader's current open orders */
  private leaderOrders = new Map<number, LeaderOrder>();

  /** Order mapping: leaderOid → OrderMapping */
  private orderMapping = new Map<number, OrderMapping>();

  /** WebSocket subscription handle */
  private subscription: SubscriptionHandle | null = null;

  /** Whether the service has started */
  private started = false;

  /** Whether the initial snapshot has been received */
  private isInitialized = false;

  constructor(private readonly deps: OrderMirrorDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd;
  }

  /**
   * Starts the order mirror service.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.log.info("📋 限价单镜像模式启动中...", {
      pairId: this.deps.pairId,
      leaderAddress: this.deps.leaderAddress,
    });

    // 1. Recover mappings from existing follower orders (handles restart)
    await this.recoverMappingFromExistingOrders();

    // 2. Subscribe to leader's open orders
    await this.subscribeLeaderOrders();

    this.started = true;
    this.log.info("📋 限价单镜像模式已启用", {
      recoveredMappings: this.orderMapping.size,
    });
  }

  /**
   * Stops the order mirror service.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.log.info("📋 停止限价单镜像服务");

    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
      } catch (error) {
        this.log.error("取消订阅失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.subscription = null;
    }

    this.started = false;
  }

  /**
   * Recovers order mappings from existing follower orders.
   * This handles the restart scenario where mappings are lost but orders still exist.
   */
  private async recoverMappingFromExistingOrders(): Promise<void> {
    try {
      const response = await this.deps.infoClient.openOrders({
        user: this.deps.followerAddress,
      });

      let recoveredCount = 0;

      for (const order of response) {
        // Parse cloid to extract leaderOid
        const leaderOid = this.parseCloid(order.cloid);

        if (leaderOid !== null) {
          this.orderMapping.set(leaderOid, {
            leaderOid,
            followerOid: order.oid,
            cloid: order.cloid!,
            coin: order.coin,
            leaderSize: 0, // Unknown after restart
            followerSize: parseFloat(order.sz),
            createdAt: order.timestamp,
          });
          recoveredCount++;
        }
      }

      this.log.info("📋 [限价单] 从现有挂单恢复映射", {
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
   * Subscribes to leader's open orders WebSocket feed.
   */
  private async subscribeLeaderOrders(): Promise<void> {
    this.log.info("📋 [限价单] 订阅领航员挂单...", {
      leaderAddress: this.deps.leaderAddress,
    });

    const subscription = await this.deps.subscriptionClient.openOrders(
      { user: this.deps.leaderAddress },
      async (event) => {
        await this.handleOrdersUpdate(event.orders as LeaderOrder[]);
      },
    );

    this.subscription = {
      unsubscribe: () => subscription.unsubscribe(),
    };

    this.log.info("📋 [限价单] 订阅成功，等待挂单数据...");
  }

  /**
   * Handles orders update from WebSocket.
   */
  private async handleOrdersUpdate(orders: LeaderOrder[]): Promise<void> {
    // First update is the snapshot (use explicit flag instead of implicit check)
    if (!this.isInitialized) {
      await this.handleOrdersSnapshot(orders);
      this.isInitialized = true;
      return;
    }

    // Subsequent updates: detect changes
    await this.detectOrderChanges(orders);
  }

  /**
   * Handles the initial orders snapshot.
   */
  private async handleOrdersSnapshot(orders: LeaderOrder[]): Promise<void> {
    this.log.info("📋 [限价单] 收到领航员挂单快照", {
      count: orders.length,
    });

    const leaderOidSet = new Set(orders.map((o) => o.oid));

    // 1. Clean up invalid mappings (leader no longer has this order)
    for (const [leaderOid, mapping] of this.orderMapping) {
      if (!leaderOidSet.has(leaderOid)) {
        this.log.info("📋 [限价单] 清理无效映射（领航员已取消）", {
          leaderOid,
          followerOid: mapping.followerOid,
          coin: mapping.coin,
        });
        await this.cancelFollowerOrderByOid(mapping.followerOid, mapping.coin);
        this.orderMapping.delete(leaderOid);
      }
    }

    // 2. Follow orders not yet followed
    for (const order of orders) {
      if (!this.orderMapping.has(order.oid)) {
        await this.placeFollowerOrder(order);
      }
    }

    // 3. Update local cache
    this.leaderOrders = new Map(orders.map((o) => [o.oid, o]));

    this.log.info("📋 [限价单] 快照处理完成", {
      leaderOrders: this.leaderOrders.size,
      followedOrders: this.orderMapping.size,
    });
  }

  /**
   * Detects order changes between current and new order list.
   * Properly awaits all async operations to ensure correct error handling and ordering.
   */
  private async detectOrderChanges(newOrders: LeaderOrder[]): Promise<void> {
    const newOrderMap = new Map(newOrders.map((o) => [o.oid, o]));
    const placePromises: Promise<void>[] = [];
    const cancelPromises: Promise<void>[] = [];

    // Detect new orders
    for (const [oid, order] of newOrderMap) {
      if (!this.leaderOrders.has(oid)) {
        this.log.info("📋 [限价单] 领航员新增挂单", {
          coin: order.coin,
          side: order.side === "B" ? "买入" : "卖出",
          price: "$" + order.limitPx,
          size: order.sz,
          reduceOnly: order.reduceOnly,
          oid: order.oid,
        });
        placePromises.push(this.placeFollowerOrder(order));
      }
    }

    // Detect removed orders (cancelled or filled)
    for (const [oid, order] of this.leaderOrders) {
      if (!newOrderMap.has(oid)) {
        this.log.info("📋 [限价单] 领航员挂单消失", {
          coin: order.coin,
          oid: order.oid,
          reason: "取消或成交",
        });
        cancelPromises.push(this.cancelFollowerOrder(oid));
      }
    }

    // Wait for all operations to complete before updating cache
    // This ensures state consistency
    try {
      await Promise.all([...placePromises, ...cancelPromises]);
    } catch (error) {
      this.log.error("[限价单] 批量处理订单变更时出错", {
        error: error instanceof Error ? error.message : String(error),
        placeCount: placePromises.length,
        cancelCount: cancelPromises.length,
      });
    }

    // Update cache after all operations complete
    this.leaderOrders = newOrderMap;
  }

  /**
   * Places a follower order mirroring the leader's order.
   */
  private async placeFollowerOrder(leaderOrder: LeaderOrder): Promise<void> {
    // Check if already followed
    if (this.orderMapping.has(leaderOrder.oid)) {
      return;
    }

    // Calculate follower size
    const leaderSize = parseFloat(leaderOrder.sz);
    const followerSize = this.calculateFollowerSize(leaderSize);
    const price = parseFloat(leaderOrder.limitPx);
    const notional = followerSize * price;

    // Check minimum notional
    if (notional < this.minOrderNotionalUsd) {
      this.log.debug("[限价单] 金额不足最小阈值，跳过", {
        coin: leaderOrder.coin,
        notional: "$" + notional.toFixed(2),
        min: "$" + this.minOrderNotionalUsd,
      });
      return;
    }

    // Get coin metadata
    const metadata = this.deps.metadataService.getByCoin(leaderOrder.coin);
    if (!metadata) {
      this.log.warn("[限价单] 无法获取币种元数据", { coin: leaderOrder.coin });
      return;
    }

    // Build order
    const cloid = this.makeCloid(leaderOrder.oid);
    const sizeStr = followerSize.toFixed(metadata.sizeDecimals);

    // Skip if size rounds to zero
    if (parseFloat(sizeStr) === 0) {
      this.log.debug("[限价单] 数量取整后为零，跳过", { coin: leaderOrder.coin });
      return;
    }

    const order = {
      a: metadata.assetId,
      b: leaderOrder.side === "B",
      p: leaderOrder.limitPx, // Use leader's exact price
      s: sizeStr,
      r: leaderOrder.reduceOnly,
      t: { limit: { tif: "Gtc" as const } }, // GTC limit order
      c: cloid,
    };

    try {
      const response = await this.deps.exchangeClient.order({
        orders: [order],
        grouping: "na",
      });

      const statuses = response.response.data.statuses;
      if (statuses.length === 0) {
        this.log.warn("[限价单] 下单响应为空", { coin: leaderOrder.coin });
        return;
      }

      const status = statuses[0];

      if (status && "resting" in status) {
        const followerOid = status.resting.oid;

        this.orderMapping.set(leaderOrder.oid, {
          leaderOid: leaderOrder.oid,
          followerOid,
          cloid,
          coin: leaderOrder.coin,
          leaderSize,
          followerSize,
          createdAt: Date.now(),
        });

        this.log.info("✅ [限价单] 跟单挂单成功", {
          coin: leaderOrder.coin,
          side: leaderOrder.side === "B" ? "买入" : "卖出",
          price: "$" + leaderOrder.limitPx,
          leaderSize: leaderOrder.sz,
          followerSize: sizeStr,
          leaderOid: leaderOrder.oid,
          followerOid,
        });
      } else if (status && "filled" in status) {
        // Order filled immediately - still record the mapping for consistency
        // This ensures cancelFollowerOrder won't fail when leader cancels
        const filledOid = status.filled.oid;

        this.orderMapping.set(leaderOrder.oid, {
          leaderOid: leaderOrder.oid,
          followerOid: filledOid,
          cloid,
          coin: leaderOrder.coin,
          leaderSize,
          followerSize,
          createdAt: Date.now(),
        });

        this.log.info("✅ [限价单] 跟单挂单立即成交", {
          coin: leaderOrder.coin,
          side: leaderOrder.side === "B" ? "买入" : "卖出",
          price: "$" + leaderOrder.limitPx,
          leaderSize: leaderOrder.sz,
          followerSize: sizeStr,
          leaderOid: leaderOrder.oid,
          followerOid: filledOid,
        });
      } else if (status && "error" in status) {
        this.log.error("❌ [限价单] 跟单挂单失败", {
          coin: leaderOrder.coin,
          error: (status as { error: string }).error,
        });
      }
    } catch (error) {
      this.log.error("❌ [限价单] 跟单挂单异常", {
        coin: leaderOrder.coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cancels the follower order corresponding to a leader order.
   */
  private async cancelFollowerOrder(leaderOid: number): Promise<void> {
    const mapping = this.orderMapping.get(leaderOid);
    if (!mapping) {
      return;
    }

    await this.cancelFollowerOrderByOid(mapping.followerOid, mapping.coin);
    this.orderMapping.delete(leaderOid);
  }

  /**
   * Cancels a follower order by its oid.
   */
  private async cancelFollowerOrderByOid(followerOid: number, coin: string): Promise<void> {
    try {
      // Get asset ID for the coin
      const metadata = this.deps.metadataService.getByCoin(coin);
      if (!metadata) {
        this.log.warn("[限价单] 取消挂单时无法获取币种元数据", { coin });
        return;
      }

      await this.deps.exchangeClient.cancel({
        cancels: [{ a: metadata.assetId, o: followerOid }],
      });

      this.log.info("✅ [限价单] 取消跟单挂单成功", {
        followerOid,
        coin,
      });
    } catch (error) {
      // Order may have already been filled or cancelled
      this.log.debug("[限价单] 取消挂单失败（可能已成交）", {
        followerOid,
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Calculates follower size based on fund ratio and copy ratio.
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
   * Creates a cloid (client order ID) that encodes the leader's oid.
   * This allows recovering mappings after restart.
   */
  private makeCloid(leaderOid: number): string {
    // Format: 0x + "mirror" hex + leaderOid hex
    // Ensures uniqueness and traceability
    const prefixHex = Buffer.from(CLOID_PREFIX).toString("hex");
    const oidHex = leaderOid.toString(16).padStart(16, "0");
    // cloid max 32 characters (0x + 30 hex chars)
    return `0x${prefixHex}${oidHex}`.slice(0, 34);
  }

  /**
   * Parses a cloid to extract the leader's oid.
   * Returns null if the cloid is not from this service.
   */
  private parseCloid(cloid: string | null | undefined): number | null {
    if (!cloid) return null;

    try {
      const prefixHex = Buffer.from(CLOID_PREFIX).toString("hex");
      const expectedPrefix = `0x${prefixHex}`;

      if (!cloid.startsWith(expectedPrefix)) {
        return null; // Not created by this service
      }

      const oidHex = cloid.slice(expectedPrefix.length);
      return parseInt(oidHex, 16);
    } catch {
      return null;
    }
  }
}
