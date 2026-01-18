/**
 * Signal processor for copy trading.
 *
 * Core responsibilities:
 * - Aggregate fills by order ID (oid) to reduce order count
 * - Parse trading direction from fill's `dir` field
 * - Filter historical positions
 * - Calculate follower's copy size based on fund ratio and copy ratio
 * - Execute copy trades
 *
 * This is the single source of truth for trading signals.
 * All copy trades are triggered by WebSocket fill events.
 */

import type * as hl from "@nktkas/hyperliquid";
import type { UserFillsEvent } from "@nktkas/hyperliquid/api/subscription";
import type { PairRiskConfig } from "../config/types.js";
import type { RiskConfig } from "../config/index.js";
import { logger, type Logger } from "../utils/logger.js";
import { TradeLogger } from "../utils/tradeLogger.js";
import type { TradingSignal, TradingDirection, CopyAction } from "../domain/types.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import type { MarketMetadataService } from "./marketMetadata.js";
import type { FollowerState } from "../domain/followerState.js";
import type { LeaderState } from "../domain/leaderState.js";
import { clamp } from "../utils/math.js";
import { randomUUID } from "node:crypto";

/** Minimum position size to consider non-zero */
const EPSILON = 1e-9;

/** Default minimum order notional (USD) - Hyperliquid minimum is $10 */
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 15;

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
 * Aggregated fill for a single order (may contain multiple partial fills).
 */
interface AggregatedFill {
  coin: string;
  direction: TradingDirection;
  totalSize: number;
  totalNotional: number;
  startPosition: number;
  endPosition: number;
  timestamp: number;
  crossed: boolean;
  oid: number;
}

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
 * Dependencies for SignalProcessor.
 */
export interface SignalProcessorDeps {
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
  risk: RiskConfig | PairRiskConfig;
  /** Minimum order notional in USD */
  minOrderNotionalUsd?: number;
  /** Historical position tracker */
  historyTracker?: HistoryPositionTracker;
  /** Whether to sync leverage with leader */
  syncLeverage?: boolean;
  /** Logger instance */
  log?: Logger;
  /** Pair ID for logging */
  pairId?: string;
  /** Log directory for trade logs */
  logDir?: string;
  /** Whether to enable trade logging to files */
  enableTradeLog?: boolean;
}

/**
 * Signal processor for copy trading.
 * Single source of truth for trading signals from WebSocket fills.
 */
export class SignalProcessor {
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;
  private readonly syncLeverage: boolean;
  private readonly tradeLogger: TradeLogger | null;
  private processing = false;

  /** Cache of leverage settings already synced */
  private readonly syncedLeverageCache = new Map<string, { leverage: number; isCross: boolean }>();

  constructor(private readonly deps: SignalProcessorDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd ?? DEFAULT_MIN_ORDER_NOTIONAL_USD;
    this.syncLeverage = deps.syncLeverage ?? true;

    // Initialize trade logger if enabled
    if (deps.enableTradeLog && deps.logDir) {
      this.tradeLogger = new TradeLogger(
        {
          logDir: deps.logDir,
          pairId: deps.pairId ?? "default",
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
   * Process a batch of fills from WebSocket event.
   * Aggregates by oid, filters historical positions, and executes copy trades.
   */
  async processFillEvent(event: UserFillsEvent): Promise<void> {
    if (this.processing) {
      this.log.debug("Signal processing already in progress, skipping");
      return;
    }

    if (event.fills.length === 0) {
      return;
    }

    this.processing = true;
    try {
      // Step 1: Aggregate fills by oid
      const aggregatedFills = this.aggregateFills(event.fills as RawFill[]);

      this.log.info("Processing leader signals", {
        rawFillCount: event.fills.length,
        aggregatedCount: aggregatedFills.length,
      });

      // Step 2: Convert to trading signals and filter
      const signals = this.convertToSignals(aggregatedFills);

      if (signals.length === 0) {
        this.log.info("No actionable signals after filtering");
        return;
      }

      // Step 3: Refresh follower state for accurate equity
      await this.refreshFollowerState();

      // Step 4: Process each signal
      for (const signal of signals) {
        await this.processSignal(signal);
      }
    } catch (error) {
      this.log.error("Error processing fill event", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.processing = false;
    }
  }

  /**
   * Check if a fill is a spot trade (not perps).
   * Spot coins have @ prefix like @142, @107
   * Spot directions are "Buy" or "Sell" instead of "Open Long" etc.
   */
  private isSpotTrade(fill: RawFill): boolean {
    // Check coin format: spot coins have @ prefix
    if (fill.coin.startsWith("@")) {
      return true;
    }
    // Check direction: spot trades use "Buy"/"Sell"
    // Perps use: "Open Long", "Close Long", "Open Short", "Close Short", "Long > Short", "Short > Long"
    const perpDirections = [
      "Open Long",
      "Close Long",
      "Open Short",
      "Close Short",
      "Long > Short",   // 反向开仓：多转空
      "Short > Long",   // 反向开仓：空转多
    ];
    if (!perpDirections.includes(fill.dir)) {
      return true;
    }
    return false;
  }

  /**
   * Aggregate multiple fills into single entries by oid.
   * Same order may be filled in multiple partial trades.
   * Filters out spot trades (only processes perps).
   */
  private aggregateFills(fills: RawFill[]): AggregatedFill[] {
    const byOid = new Map<number, AggregatedFill>();

    for (const fill of fills) {
      // Skip spot trades - only copy perps (contracts)
      if (this.isSpotTrade(fill)) {
        this.log.debug("Skipping spot trade", {
          coin: fill.coin,
          dir: fill.dir,
          reason: "现货交易，只跟单合约",
        });
        this.tradeLogger?.logTradeSkipped(fill.coin, "现货交易，只跟单合约");
        continue;
      }

      const size = parseFloat(fill.sz);
      const price = parseFloat(fill.px);
      const startPos = parseFloat(fill.startPosition);
      const isBuy = fill.side === "B";

      const existing = byOid.get(fill.oid);
      if (existing) {
        // Aggregate: sum size, weighted average price
        existing.totalSize += size;
        existing.totalNotional += size * price;
        // Update end position (latest fill has the final state)
        existing.endPosition = isBuy
          ? existing.endPosition + size
          : existing.endPosition - size;
        // Use latest timestamp
        if (fill.time > existing.timestamp) {
          existing.timestamp = fill.time;
        }
      } else {
        // Calculate end position from start position and fill
        const endPos = isBuy ? startPos + size : startPos - size;

        byOid.set(fill.oid, {
          coin: fill.coin,
          direction: fill.dir as TradingDirection,
          totalSize: size,
          totalNotional: size * price,
          startPosition: startPos,
          endPosition: endPos,
          timestamp: fill.time,
          crossed: fill.crossed,
          oid: fill.oid,
        });
      }
    }

    return Array.from(byOid.values());
  }

  /**
   * Convert aggregated fills to trading signals, filtering historical positions.
   */
  private convertToSignals(aggregatedFills: AggregatedFill[]): TradingSignal[] {
    const signals: TradingSignal[] = [];

    for (const agg of aggregatedFills) {
      const avgPrice = agg.totalNotional / agg.totalSize;
      const isNewPosition = Math.abs(agg.startPosition) < EPSILON;
      const isFullClose = Math.abs(agg.endPosition) < EPSILON;

      // Check historical position filtering
      if (this.deps.historyTracker) {
        const canCopy = this.deps.historyTracker.canCopy(agg.coin, agg.endPosition);
        if (!canCopy) {
          const reason = isFullClose ? "历史仓位平仓，清除标记" : "历史仓位操作，不跟单";
          this.log.info("Skipping historical position operation", {
            coin: agg.coin,
            direction: agg.direction,
            reason,
          });
          // Log to trade file
          this.tradeLogger?.logTradeSkipped(agg.coin, reason);
          continue;
        }
      }

      signals.push({
        coin: agg.coin,
        direction: agg.direction,
        size: agg.totalSize,
        price: avgPrice,
        orderId: agg.oid,
        startPosition: agg.startPosition,
        endPosition: agg.endPosition,
        timestamp: agg.timestamp,
        crossed: agg.crossed,
        isNewPosition,
        isFullClose,
      });
    }

    return signals;
  }

  /**
   * Process a single trading signal and execute the copy trade.
   */
  private async processSignal(signal: TradingSignal): Promise<void> {
    // Calculate fund ratio and copy size
    const leaderEquity = this.deps.leaderState.getMetrics().accountValueUsd;
    const followerEquity = this.deps.followerState.getMetrics().accountValueUsd;

    // Update trade logger with current equity
    this.tradeLogger?.updateEquity(leaderEquity, followerEquity);

    // Log received signal to file
    this.tradeLogger?.logSignal(signal);

    if (leaderEquity <= 0) {
      this.log.warn("Leader equity is zero or negative, skipping", { leaderEquity });
      this.tradeLogger?.logTradeSkipped(signal.coin, "领航员资产为零或负数");
      return;
    }

    if (followerEquity <= 0) {
      this.log.warn("Follower equity is zero or negative, skipping", { followerEquity });
      this.tradeLogger?.logTradeSkipped(signal.coin, "跟单者资产为零或负数");
      return;
    }

    const fundRatio = followerEquity / leaderEquity;
    const copyRatio = this.deps.risk.copyRatio ?? 1;
    let followerSize = signal.size * fundRatio * copyRatio;

    // Calculate notional value
    let notional = followerSize * signal.price;

    // Determine if this is an opening (increase position) or closing (reduce position) action
    const isOpeningAction = this.isOpeningDirection(signal.direction);

    // Determine action type description
    const actionDesc = this.getActionDescription(signal);

    // Log signal details
    this.log.info(`🔔 Leader signal: ${actionDesc}`, {
      coin: signal.coin,
      direction: signal.direction,
      leaderSize: signal.size.toFixed(6),
      leaderNotional: "$" + (signal.size * signal.price).toFixed(2),
      price: "$" + signal.price.toFixed(2),
      isNewPosition: signal.isNewPosition,
      isFullClose: signal.isFullClose,
      isOpeningAction,
    });

    // 方案 C：开仓提升到最小金额，减仓免阈值
    // 安全余量：在最小阈值基础上加 $1，避免精度截断后低于交易所限制
    const boostTargetNotional = this.minOrderNotionalUsd + 1; // $10 + $1 = $11

    if (isOpeningAction) {
      // 开仓/加仓：如果金额不足最小阈值，提升到 boostTargetNotional
      if (notional < this.minOrderNotionalUsd) {
        const originalNotional = notional;
        const originalSize = followerSize;
        // 提升 size 使金额达到 boostTargetNotional（带安全余量）
        followerSize = boostTargetNotional / signal.price;
        notional = boostTargetNotional;
        this.log.info(`📈 Boosting open position to minimum`, {
          coin: signal.coin,
          originalNotional: "$" + originalNotional.toFixed(2),
          boostedNotional: "$" + notional.toFixed(2),
          originalSize: originalSize.toFixed(6),
          boostedSize: followerSize.toFixed(6),
          reason: "开仓金额不足，提升到最小阈值+安全余量",
        });
      }
    } else {
      // 减仓/平仓：免除最小阈值检查（减仓是降低风险，应该执行）
      // 但如果金额太小（< $1），记录一下但仍然执行
      if (notional < this.minOrderNotionalUsd) {
        this.log.info(`📉 Executing reduce position below threshold`, {
          coin: signal.coin,
          notional: "$" + notional.toFixed(2),
          threshold: "$" + this.minOrderNotionalUsd.toFixed(2),
          reason: "减仓免阈值，降低风险优先",
        });
      }
    }

    // Determine action
    const action = this.determineAction(signal, followerSize);
    if (!action) {
      this.log.debug("No action determined for signal", { signal });
      this.tradeLogger?.logTradeSkipped(signal.coin, "无法确定交易动作");
      return;
    }

    // Sync leverage if opening new position
    if (signal.isNewPosition && this.syncLeverage) {
      await this.syncLeverageForCoin(signal.coin);
    }

    // Execute the trade
    await this.executeAction(action);
  }

  /**
   * Determine the copy action based on signal direction.
   */
  private determineAction(signal: TradingSignal, followerSize: number): CopyAction | null {
    const { direction, coin, price } = signal;

    // Get current follower position
    const followerPos = this.deps.followerState.getPosition(coin);
    const currentFollowerSize = followerPos?.size ?? 0;

    let action: "buy" | "sell";
    let reduceOnly = false;
    let actualSize = followerSize;
    let description: string;

    switch (direction) {
      case "Open Long":
        action = "buy";
        description = signal.isNewPosition ? "🟢 新开多仓" : "🟢 加多仓";
        break;

      case "Open Short":
        action = "sell";
        description = signal.isNewPosition ? "🔴 新开空仓" : "🔴 加空仓";
        break;

      case "Close Long":
        action = "sell";
        reduceOnly = true;
        // 跟单者没有多仓，跳过
        if (currentFollowerSize <= 0) {
          this.log.debug("No long position to reduce, skipping", { coin, currentFollowerSize });
          return null;
        }
        // 计算减仓相关数值
        const longReduceSize = Math.min(followerSize, currentFollowerSize);
        const longReduceNotional = longReduceSize * price;
        const longPositionNotional = currentFollowerSize * price;  // 跟单者全部仓位价值
        const longBoostTarget = this.minOrderNotionalUsd + 1;  // $11 安全余量

        // 检查领航员当前实际仓位（解决 fills 分批到达导致 isFullClose 判断不准的问题）
        const leaderLongPos = this.deps.leaderState.getPosition(coin);
        const leaderLongSize = leaderLongPos?.size ?? 0;
        const leaderHasNoLongPosition = leaderLongSize <= EPSILON;

        if (signal.isFullClose || leaderHasNoLongPosition) {
          // 领航员完全平仓或已无仓位 → 跟单者也平全部
          actualSize = currentFollowerSize;
          description = leaderHasNoLongPosition && !signal.isFullClose
            ? "⬜ 平多仓(领航员已无仓位)"
            : "⬜ 平多仓";
        } else if (longReduceNotional >= this.minOrderNotionalUsd) {
          // 减仓金额足够 → 正常减仓
          actualSize = longReduceSize;
          description = "🟡 减多仓";
        } else if (longPositionNotional >= longBoostTarget) {
          // 仓位够大，提升减仓到 $11
          actualSize = longBoostTarget / price;
          description = "🟡 减多仓(提升到最小金额)";
        } else {
          // 仓位太小，直接平全部
          actualSize = currentFollowerSize;
          description = "⬜ 平多仓(仓位不足最小金额)";
        }
        break;

      case "Close Short":
        action = "buy";
        reduceOnly = true;
        // 跟单者没有空仓，跳过
        if (currentFollowerSize >= 0) {
          this.log.debug("No short position to reduce, skipping", { coin, currentFollowerSize });
          return null;
        }
        // 计算减仓相关数值
        const absFollowerSize = Math.abs(currentFollowerSize);
        const shortReduceSize = Math.min(followerSize, absFollowerSize);
        const shortReduceNotional = shortReduceSize * price;
        const shortPositionNotional = absFollowerSize * price;  // 跟单者全部仓位价值
        const shortBoostTarget = this.minOrderNotionalUsd + 1;  // $11 安全余量

        // 检查领航员当前实际仓位（解决 fills 分批到达导致 isFullClose 判断不准的问题）
        const leaderShortPos = this.deps.leaderState.getPosition(coin);
        const leaderShortSize = leaderShortPos?.size ?? 0;
        const leaderHasNoShortPosition = leaderShortSize >= -EPSILON;

        if (signal.isFullClose || leaderHasNoShortPosition) {
          // 领航员完全平仓或已无仓位 → 跟单者也平全部
          actualSize = absFollowerSize;
          description = leaderHasNoShortPosition && !signal.isFullClose
            ? "⬜ 平空仓(领航员已无仓位)"
            : "⬜ 平空仓";
        } else if (shortReduceNotional >= this.minOrderNotionalUsd) {
          // 减仓金额足够 → 正常减仓
          actualSize = shortReduceSize;
          description = "🟡 减空仓";
        } else if (shortPositionNotional >= shortBoostTarget) {
          // 仓位够大，提升减仓到 $11
          actualSize = shortBoostTarget / price;
          description = "🟡 减空仓(提升到最小金额)";
        } else {
          // 仓位太小，直接平全部
          actualSize = absFollowerSize;
          description = "⬜ 平空仓(仓位不足最小金额)";
        }
        break;

      // 反向开仓：多转空 (卖出平多 + 开空)
      case "Long > Short":
        action = "sell";
        // 不设 reduceOnly，允许反向开仓
        // 计算实际需要的卖出数量 = 平掉多仓 + 开空仓
        description = "🔄 反向：多转空";
        break;

      // 反向开仓：空转多 (买入平空 + 开多)
      case "Short > Long":
        action = "buy";
        // 不设 reduceOnly，允许反向开仓
        // 计算实际需要的买入数量 = 平掉空仓 + 开多仓
        description = "🔄 反向：空转多";
        break;

      default:
        this.log.warn("Unknown direction", { direction });
        return null;
    }

    return {
      coin,
      action,
      size: actualSize,
      price,
      reduceOnly,
      description,
    };
  }

  /**
   * Execute a copy action by placing an order.
   * Uses mid price (order book midpoint) for execution, matching official SDK behavior.
   */
  private async executeAction(action: CopyAction): Promise<void> {
    const metadata = this.deps.metadataService.getByCoin(action.coin);
    if (!metadata) {
      this.log.error("No metadata for coin", { coin: action.coin });
      return;
    }

    // 刷新中间价以获取最新订单簿价格（与官方 SDK 一致）
    await this.deps.metadataService.refreshMidPrices();

    // 优先使用中间价（订单簿中点），回退到标记价格，最后使用信号价格
    const executionPrice = this.deps.metadataService.getExecutionPrice(action.coin) ?? action.price;
    const markPrice = this.deps.metadataService.getMarkPrice(action.coin) ?? executionPrice;

    // 从配置获取滑点，默认 5%（与官方 SDK 一致）
    const slippage = this.deps.risk.marketOrderSlippage ?? 0.05;
    
    // 市价单 = 激进限价单 + IoC（与官方 SDK 实现一致）
    // 使用 Ioc (Immediate or Cancel) 确保立即成交或取消
    const priceMultiplier = action.action === "buy" ? 1 + slippage : 1 - slippage;
    const limitPrice = clamp(executionPrice * priceMultiplier, executionPrice * 0.5, executionPrice * 2);
    const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);

    const sizeStr = action.size.toFixed(metadata.sizeDecimals);

    // Skip if size rounds to zero
    if (parseFloat(sizeStr) === 0) {
      this.log.debug("Size rounds to zero, skipping", { coin: action.coin });
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

    // 使用 Ioc (Immediate or Cancel) 订单类型
    // 配合 10% 滑点保护，实现类似市价单的立即成交效果
    const order = {
      a: metadata.assetId,
      b: action.action === "buy",
      p: priceStr,
      s: sizeStr,
      r: action.reduceOnly,
      t: {
        limit: {
          tif: "Ioc" as const, // Immediate or Cancel - 立即成交或取消
        },
      },
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
        this.log.info("✅ Order executed successfully", { coin: action.coin });
        // Log success to trade log
        this.tradeLogger?.logTradeSuccess(action);
      }
      if (errors.length > 0) {
        const errorMsg = errors.map((e) => ("error" in e ? e.error : "unknown")).join(", ");
        this.log.warn("❌ Order failed", {
          coin: action.coin,
          errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
        });
        // Log failure to trade log
        this.tradeLogger?.logTradeFailed(action, errorMsg);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("Insufficient margin")) {
        this.log.warn("Order failed: insufficient margin", { coin: action.coin });
        this.tradeLogger?.logTradeFailed(action, "保证金不足");
      } else {
        this.log.error("Order execution failed", {
          coin: action.coin,
          error: errorMessage,
        });
        this.tradeLogger?.logTradeFailed(action, errorMessage);
        this.tradeLogger?.logError("订单执行异常", error instanceof Error ? error : undefined);
      }
    }
  }

  /**
   * Check if the direction is an opening action (increase position).
   * Opening: Open Long, Open Short, Long > Short, Short > Long
   * Closing: Close Long, Close Short
   */
  private isOpeningDirection(direction: TradingDirection): boolean {
    switch (direction) {
      case "Open Long":
      case "Open Short":
      case "Long > Short": // 反向开仓也是开仓（会建立新方向的仓位）
      case "Short > Long":
        return true;
      case "Close Long":
      case "Close Short":
        return false;
      default:
        return true; // 默认当作开仓处理（更安全）
    }
  }

  /**
   * Get human-readable description of the signal action.
   */
  private getActionDescription(signal: TradingSignal): string {
    const { direction, isNewPosition, isFullClose } = signal;

    switch (direction) {
      case "Open Long":
        return isNewPosition ? "新开多仓" : "加多仓";
      case "Open Short":
        return isNewPosition ? "新开空仓" : "加空仓";
      case "Close Long":
        return isFullClose ? "平多仓" : "减多仓";
      case "Close Short":
        return isFullClose ? "平空仓" : "减空仓";
      case "Long > Short":
        return "反向：多转空";
      case "Short > Long":
        return "反向：空转多";
      default:
        return direction;
    }
  }

  /**
   * Refresh follower state from exchange.
   */
  private async refreshFollowerState(): Promise<void> {
    try {
      const [leaderState, followerState] = await Promise.all([
        this.deps.infoClient.clearinghouseState({ user: this.deps.leaderAddress }),
        this.deps.infoClient.clearinghouseState({ user: this.deps.followerAddress }),
      ]);
      this.deps.leaderState.applyClearinghouseState(leaderState);
      this.deps.followerState.applyClearinghouseState(followerState);
    } catch (error) {
      this.log.warn("Failed to refresh state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync leverage setting for a coin before opening position.
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

    // Check cache
    const cached = this.syncedLeverageCache.get(coin);
    if (cached && cached.leverage === leverage && cached.isCross === isCross) {
      return;
    }

    try {
      this.log.info("Syncing leverage", { coin, leverage, mode: isCross ? "cross" : "isolated" });
      await this.deps.exchangeClient.updateLeverage({
        asset: metadata.assetId,
        isCross,
        leverage,
      });
      this.syncedLeverageCache.set(coin, { leverage, isCross });
    } catch (error) {
      this.log.warn("Failed to sync leverage", {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
