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
}

/**
 * Signal processor for copy trading.
 * Single source of truth for trading signals from WebSocket fills.
 */
export class SignalProcessor {
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;
  private readonly syncLeverage: boolean;
  private processing = false;

  /** Cache of leverage settings already synced */
  private readonly syncedLeverageCache = new Map<string, { leverage: number; isCross: boolean }>();

  constructor(private readonly deps: SignalProcessorDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd ?? DEFAULT_MIN_ORDER_NOTIONAL_USD;
    this.syncLeverage = deps.syncLeverage ?? true;
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
   * Aggregate multiple fills into single entries by oid.
   * Same order may be filled in multiple partial trades.
   */
  private aggregateFills(fills: RawFill[]): AggregatedFill[] {
    const byOid = new Map<number, AggregatedFill>();

    for (const fill of fills) {
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
          this.log.info("Skipping historical position operation", {
            coin: agg.coin,
            direction: agg.direction,
            reason: isFullClose ? "历史仓位平仓，清除标记" : "历史仓位操作，不跟单",
          });
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

    if (leaderEquity <= 0) {
      this.log.warn("Leader equity is zero or negative, skipping", { leaderEquity });
      return;
    }

    if (followerEquity <= 0) {
      this.log.warn("Follower equity is zero or negative, skipping", { followerEquity });
      return;
    }

    const fundRatio = followerEquity / leaderEquity;
    const copyRatio = this.deps.risk.copyRatio ?? 1;
    const followerSize = signal.size * fundRatio * copyRatio;

    // Calculate notional value
    const notional = followerSize * signal.price;

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
    });

    // Check minimum notional
    if (notional < this.minOrderNotionalUsd) {
      this.log.info(`⏭️ Skipping small trade`, {
        coin: signal.coin,
        followerNotional: "$" + notional.toFixed(2),
        threshold: "$" + this.minOrderNotionalUsd.toFixed(2),
        reason: "金额低于最小阈值",
      });
      return;
    }

    // Determine action
    const action = this.determineAction(signal, followerSize);
    if (!action) {
      this.log.debug("No action determined for signal", { signal });
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
        // Don't sell more than we have
        if (currentFollowerSize > 0) {
          actualSize = Math.min(followerSize, currentFollowerSize);
        }
        description = signal.isFullClose ? "⬜ 平多仓" : "🟡 减多仓";
        break;

      case "Close Short":
        action = "buy";
        reduceOnly = true;
        // Don't buy more than needed to close
        if (currentFollowerSize < 0) {
          actualSize = Math.min(followerSize, Math.abs(currentFollowerSize));
        }
        description = signal.isFullClose ? "⬜ 平空仓" : "🟡 减空仓";
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
   */
  private async executeAction(action: CopyAction): Promise<void> {
    const metadata = this.deps.metadataService.getByCoin(action.coin);
    if (!metadata) {
      this.log.error("No metadata for coin", { coin: action.coin });
      return;
    }

    const markPrice = this.deps.metadataService.getMarkPrice(action.coin) ?? action.price;

    // Calculate slippage price (3% for protection)
    const slippage = Math.max((this.deps.risk.maxSlippageBps ?? 300) / 10_000, 0.03);
    const priceMultiplier = action.action === "buy" ? 1 + slippage : 1 - slippage;
    const limitPrice = clamp(markPrice * priceMultiplier, markPrice * 0.1, markPrice * 10);
    const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);

    const sizeStr = action.size.toFixed(metadata.sizeDecimals);

    // Skip if size rounds to zero
    if (parseFloat(sizeStr) === 0) {
      this.log.debug("Size rounds to zero, skipping", { coin: action.coin });
      return;
    }

    const notional = action.size * markPrice;

    this.log.info(`${action.description}`, {
      coin: action.coin,
      action: action.action === "buy" ? "买入" : "卖出",
      size: sizeStr,
      notional: "$" + notional.toFixed(2),
      price: "$" + markPrice.toFixed(2),
      reduceOnly: action.reduceOnly,
    });

    const order = {
      a: metadata.assetId,
      b: action.action === "buy",
      p: priceStr,
      s: sizeStr,
      r: action.reduceOnly,
      t: {
        limit: {
          tif: "FrontendMarket" as const,
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
      }
      if (errors.length > 0) {
        this.log.warn("❌ Order failed", {
          coin: action.coin,
          errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("Insufficient margin")) {
        this.log.warn("Order failed: insufficient margin", { coin: action.coin });
      } else {
        this.log.error("Order execution failed", {
          coin: action.coin,
          error: errorMessage,
        });
      }
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
