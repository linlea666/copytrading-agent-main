/**
 * Trade execution service for synchronizing follower positions with leader.
 *
 * Core responsibilities:
 * - Compute target positions from leader state
 * - Calculate position deltas with risk limits applied
 * - Filter historical positions that should not be copied
 * - Build and submit orders to Hyperliquid exchange
 *
 * Orders are constructed as IOC (Immediate-Or-Cancel) limit orders with slippage allowance.
 */

import type * as hl from "@nktkas/hyperliquid";
import { randomUUID } from "node:crypto";
import type { RiskConfig } from "../config/index.js";
import type { PairRiskConfig } from "../config/types.js";
import { logger, type Logger } from "../utils/logger.js";
import { clamp } from "../utils/math.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState, type PositionDelta } from "../domain/followerState.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import { MarketMetadataService } from "./marketMetadata.js";

/** Minimum absolute position delta to trigger an order (prevents dust trades) */
const MIN_ABS_DELTA = 1e-6;

/** Default minimum order notional (USD) - Hyperliquid minimum is $10 */
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 15;

/**
 * Determines the number of decimal places in a number's string representation.
 * Used to match the price precision of the mark price.
 */
function getDecimalPlaces(value: number): number {
  const str = value.toString();
  const decimalIndex = str.indexOf(".");
  if (decimalIndex === -1) {
    return 0;
  }
  return str.length - decimalIndex - 1;
}

/**
 * Rounds a price to match the precision of a reference price (mark price).
 * This ensures orders comply with Hyperliquid's tick size requirements.
 */
function roundToMarkPricePrecision(price: number, markPrice: number): string {
  const decimals = getDecimalPlaces(markPrice);
  const rounded = Number(price.toFixed(decimals));

  // Format with fixed decimals and strip trailing zeros if any
  let result = rounded.toFixed(decimals);

  // Only strip trailing zeros after the decimal point, keep the number valid
  if (decimals > 0) {
    result = result.replace(/\.?0+$/, "");
  }

  // Ensure we have at least one digit
  return result || "0";
}

/**
 * Leverage info for synchronization.
 */
export interface LeverageInfo {
  /** Asset ID */
  assetId: number;
  /** Leverage value (e.g., 40 for 40x) */
  leverage: number;
  /** Is cross margin mode */
  isCross: boolean;
}

/**
 * Dependencies for TradeExecutor.
 */
export interface TradeExecutorDeps {
  /** Hyperliquid exchange client for placing orders */
  exchangeClient: hl.ExchangeClient;
  /** Hyperliquid info client for fetching account state */
  infoClient: hl.InfoClient;
  /** Leader address for fetching leader state */
  leaderAddress: `0x${string}`;
  /** Follower trading address */
  followerAddress: `0x${string}`;
  /** Leader state store */
  leaderState: LeaderState;
  /** Follower state store */
  followerState: FollowerState;
  /** Market metadata service for asset details and mark prices */
  metadataService: MarketMetadataService;
  /** Risk configuration (supports both old RiskConfig and new PairRiskConfig) */
  risk: RiskConfig | PairRiskConfig;
  /**
   * Minimum order notional in USD.
   * Orders below this threshold will be skipped.
   * @default 15
   */
  minOrderNotionalUsd?: number;
  /**
   * Historical position tracker for filtering positions that should not be copied.
   * If not provided, all positions will be copied.
   */
  historyTracker?: HistoryPositionTracker;
  /**
   * Whether to sync leverage settings with leader before opening positions.
   * When true, follower's leverage will be set to match leader's leverage.
   * @default true
   */
  syncLeverage?: boolean;
  /** Optional logger instance */
  log?: Logger;
}

/**
 * Manages trade execution to synchronize follower positions with leader.
 */
export class TradeExecutor {
  private syncing = false;
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;
  private readonly syncLeverage: boolean;
  /** Cache of leverage settings already synced this session to avoid redundant API calls */
  private readonly syncedLeverageCache = new Map<string, { leverage: number; isCross: boolean }>();

  constructor(private readonly deps: TradeExecutorDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd ?? DEFAULT_MIN_ORDER_NOTIONAL_USD;
    this.syncLeverage = deps.syncLeverage ?? true;
  }

  /**
   * Syncs leverage setting for a coin before opening a position.
   * Only syncs if the leverage or mode has changed from cached value.
   */
  private async syncLeverageForCoin(
    assetId: number,
    coin: string,
    leverage: number,
    isCross: boolean,
  ): Promise<void> {
    if (!this.syncLeverage) return;

    // Check cache to avoid redundant API calls
    const cached = this.syncedLeverageCache.get(coin);
    if (cached && cached.leverage === leverage && cached.isCross === isCross) {
      this.log.debug(`Leverage already synced for ${coin}`, { leverage, isCross });
      return;
    }

    try {
      this.log.info(`Syncing leverage for ${coin}`, {
        leverage,
        mode: isCross ? "cross" : "isolated",
      });

      await this.deps.exchangeClient.updateLeverage({
        asset: assetId,
        isCross,
        leverage: Math.floor(leverage), // Leverage must be an integer
      });

      // Update cache after successful sync
      this.syncedLeverageCache.set(coin, { leverage: Math.floor(leverage), isCross });
      this.log.info(`Leverage synced successfully for ${coin}`, { leverage: Math.floor(leverage) });
    } catch (error) {
      // Log warning but don't fail the trade - leverage sync is best-effort
      this.log.warn(`Failed to sync leverage for ${coin}`, {
        error: error instanceof Error ? error.message : String(error),
        leverage,
        isCross,
      });
    }
  }

  /**
   * Synchronizes follower positions with leader by computing deltas and placing orders.
   *
   * Process:
   * 1. Refresh market metadata and mark prices
   * 2. Compute target positions from leader state (scaled by copyRatio)
   * 3. Filter out historical positions that should not be copied
   * 4. Compute deltas between follower current and target (with risk limits)
   * 5. Build and submit IOC limit orders for non-zero deltas
   *
   * Prevents concurrent syncs by using a `syncing` flag.
   */
  async syncWithLeader() {
    if (this.syncing) {
      this.log.debug("Trade sync already in progress");
      return;
    }
    this.syncing = true;
    try {
      // Ensure market metadata is loaded and mark prices are current
      await this.deps.metadataService.ensureLoaded();
      await this.deps.metadataService.refreshMarkPrices();

      // CRITICAL: Fetch fresh state from exchange before calculating deltas
      // This prevents stale state causing incorrect calculations
      // Fetch both leader and follower state in parallel for efficiency
      const [leaderClearinghouse, followerClearinghouse] = await Promise.all([
        this.deps.infoClient.clearinghouseState({ user: this.deps.leaderAddress }),
        this.deps.infoClient.clearinghouseState({ user: this.deps.followerAddress }),
      ]);
      
      // Apply leader state to get accurate leverage settings
      // WebSocket fills don't include leverage info, so we need full state
      this.deps.leaderState.applyClearinghouseState(leaderClearinghouse);
      this.deps.followerState.applyClearinghouseState(followerClearinghouse);
      
      // Log follower account status for debugging
      const followerMetrics = this.deps.followerState.getMetrics();
      this.log.debug("Follower account status", {
        equity: "$" + followerMetrics.accountValueUsd.toFixed(2),
        totalNotional: "$" + followerMetrics.totalNotionalUsd.toFixed(2),
        marginUsed: "$" + followerMetrics.totalMarginUsedUsd.toFixed(2),
        withdrawable: "$" + followerMetrics.withdrawableUsd.toFixed(2),
        positions: this.deps.followerState.getPositions().size,
      });
      
      // Warn if follower has very low or zero balance
      if (followerMetrics.accountValueUsd < 10) {
        this.log.warn("Follower account has very low balance, trades may fail", {
          equity: "$" + followerMetrics.accountValueUsd.toFixed(2),
        });
      }

      // Compute leader's current leverage for each position
      const allTargets = this.deps.leaderState.computeTargets(this.deps.metadataService);

      if (allTargets.length > 0) {
        this.log.debug("Leader positions and leverage", {
          positions: allTargets.map((t) => ({
            coin: t.coin,
            leverage: t.leaderLeverage.toFixed(2) + "x",
            markPrice: t.markPrice,
          })),
        });
      }

      // CRITICAL FIX: First, check historical positions that leader may have closed
      // This must happen BEFORE filtering targets, to clear historical markers
      // for positions that leader has fully closed (size → 0)
      if (this.deps.historyTracker) {
        const historicalCoins = this.deps.historyTracker.getHistoricalCoins();
        for (const coin of historicalCoins) {
          // Check if leader still has this position
          const leaderHasPosition = allTargets.some(t => t.coin === coin);
          if (!leaderHasPosition) {
            // Leader no longer has this position - it was closed!
            // Call canCopy with size=0 to clear the historical marker
            this.log.info(`Historical position closed by leader`, { coin });
            this.deps.historyTracker.canCopy(coin, 0);
          }
        }
      }

      // Filter out historical positions if tracker is available
      const targets = this.deps.historyTracker
        ? allTargets.filter((target) => {
            const canCopy = this.deps.historyTracker!.canCopy(target.coin, target.leaderSize);
            if (!canCopy) {
              this.log.debug(`Skipping historical position`, {
                coin: target.coin,
                size: target.leaderSize,
              });
            }
            return canCopy;
          })
        : allTargets;

      // Also handle positions that follower has but are now historical
      // These should be closed if leader no longer has them
      if (this.deps.historyTracker) {
        // Check follower positions against historical tracking
        for (const [coin, position] of this.deps.followerState.getPositions()) {
          if (this.deps.historyTracker.isHistorical(coin)) {
            // This is a position we copied before it became historical
            // We should NOT close it based on leader actions
            // It will be handled when leader actually closes (which clears historical)
            this.log.debug(`Follower has historical position, will manage independently`, { coin });
          }
        }
      }

      // Compute deltas between current and target positions (scales leverage by copyRatio)
      const deltas = this.deps.followerState.computeDeltas(targets, this.deps.risk);

      // Log delta computation results for debugging
      if (deltas.length > 0) {
        this.log.debug("Computed position deltas", {
          count: deltas.length,
          deltas: deltas.map((d) => ({
            coin: d.coin,
            currentSize: (d.current?.size ?? 0).toFixed(6),
            targetSize: d.targetSize.toFixed(6),
            deltaSize: d.deltaSize.toFixed(6),
            maxNotional: "$" + d.maxNotionalUsd.toFixed(2),
          })),
        });
      }

      // Filter out dust deltas that are too small to trade
      const actionable = deltas.filter((delta) => Math.abs(delta.deltaSize) > MIN_ABS_DELTA);

      if (actionable.length === 0) {
        // Log why no action is needed
        if (targets.length === 0) {
          this.log.debug("No copyable targets - leader has no positions or all are historical");
        } else if (deltas.every((d) => Math.abs(d.deltaSize) <= MIN_ABS_DELTA)) {
          this.log.debug("Follower already synchronized with leader");
        } else {
          this.log.debug("No actionable deltas after filtering");
        }
        return;
      }

      // Get equity values for deviation calculation
      const leaderEquity = this.deps.leaderState.getMetrics().accountValueUsd;
      const followerEquityForDeviation = followerMetrics.accountValueUsd;
      
      // Get max deviation threshold from config (default 5%)
      const maxDeviationPercent = 
        ("maxPositionDeviationPercent" in this.deps.risk 
          ? this.deps.risk.maxPositionDeviationPercent 
          : 5) ?? 5;
      
      // Calculate fund ratio for dynamic threshold
      const fundRatio = followerEquityForDeviation / leaderEquity;
      
      // Process deltas: adjust small notionals to meet minimum threshold
      // For opening/adding positions: bump up to minimum if too small
      // For reducing/closing positions: check deviation before skipping
      const processedDeltas = actionable
        .map((delta) => {
          const markPx = this.deps.metadataService.getMarkPrice(delta.coin) ?? delta.current?.entryPrice;
          if (!markPx || markPx <= 0) {
            this.log.debug(`Skipping ${delta.coin} due to missing/invalid mark price`);
            return null;
          }

          const notional = Math.abs(delta.deltaSize) * markPx;
          const currentSize = delta.current?.size ?? 0;
          
          // Calculate position deviation percentage
          // Leader's position ratio = |leaderSize * price| / leaderEquity
          // Follower's position ratio = |currentSize * price| / followerEquity
          const target = targets.find((t) => t.coin === delta.coin);
          const leaderPositionRatio = target 
            ? (Math.abs(target.leaderSize) * markPx) / leaderEquity 
            : 0;
          const followerPositionRatio = followerEquityForDeviation > 0 
            ? (Math.abs(currentSize) * markPx) / followerEquityForDeviation 
            : 0;
          const deviationPercent = Math.abs(leaderPositionRatio - followerPositionRatio) * 100;
          
          // Calculate dynamic threshold based on fund ratio
          // When fund ratio is very small (big leader, small follower), lower the threshold
          // Minimum is $10 (Hyperliquid's minimum order value)
          const dynamicThreshold = Math.max(
            10,
            this.minOrderNotionalUsd * Math.min(1, fundRatio * 500)
          );
          
          // Determine if this is opening/adding (same direction) or reducing/closing (opposite direction)
          const isOpeningOrAdding = 
            (delta.deltaSize > 0 && delta.targetSize > 0) || // buying to go/add long
            (delta.deltaSize < 0 && delta.targetSize < 0);   // selling to go/add short
          
          const isReducingOrClosing = 
            (currentSize > 0 && delta.deltaSize < 0) || // selling to reduce long
            (currentSize < 0 && delta.deltaSize > 0);   // buying to reduce short

          // Check if we should force sync due to high deviation
          const shouldForceDueToDeviation = 
            maxDeviationPercent > 0 && 
            deviationPercent > maxDeviationPercent;

          // If notional is below minimum (using dynamic threshold)
          if (notional < dynamicThreshold && !shouldForceDueToDeviation) {
            // For reducing/closing: skip if too small AND deviation is acceptable
            if (isReducingOrClosing) {
              this.log.debug(`Skipping small reduce/close for ${delta.coin}`, {
                notional: notional.toFixed(4),
                threshold: dynamicThreshold.toFixed(2),
                deviation: deviationPercent.toFixed(2) + "%",
                maxDeviation: maxDeviationPercent + "%",
              });
              return null;
            }
            
            // For opening/adding: bump up to minimum notional
            if (isOpeningOrAdding) {
              const minSize = dynamicThreshold / markPx;
              const adjustedDeltaSize = delta.deltaSize > 0 ? minSize : -minSize;
              const adjustedTargetSize = (delta.current?.size ?? 0) + adjustedDeltaSize;
              
              this.log.info(`Adjusting small order to meet minimum`, {
                coin: delta.coin,
                originalNotional: notional.toFixed(4),
                adjustedNotional: dynamicThreshold.toFixed(4),
                originalDeltaSize: delta.deltaSize.toFixed(6),
                adjustedDeltaSize: adjustedDeltaSize.toFixed(6),
              });
              
              return {
                ...delta,
                deltaSize: adjustedDeltaSize,
                targetSize: adjustedTargetSize,
              };
            }
          }
          
          // Force sync due to high deviation - log this important event
          if (shouldForceDueToDeviation && notional < this.minOrderNotionalUsd) {
            this.log.info(`Forcing sync due to high position deviation`, {
              coin: delta.coin,
              notional: notional.toFixed(4),
              deviation: deviationPercent.toFixed(2) + "%",
              maxDeviation: maxDeviationPercent + "%",
              leaderRatio: (leaderPositionRatio * 100).toFixed(2) + "%",
              followerRatio: (followerPositionRatio * 100).toFixed(2) + "%",
            });
          }

          return delta;
        })
        .filter((delta): delta is PositionDelta => delta !== null);

      if (processedDeltas.length === 0) {
        this.log.debug("No valid deltas after processing");
        return;
      }

      // Log detailed copy trading decision for each delta
      const leaderMetrics = this.deps.leaderState.getMetrics();
      for (const delta of processedDeltas) {
        const markPx = this.deps.metadataService.getMarkPrice(delta.coin) ?? 0;
        const currentSize = delta.current?.size ?? 0;
        const notionalUsd = Math.abs(delta.deltaSize) * markPx;
        
        // Determine action type
        let actionType: string;
        if (currentSize === 0 && delta.targetSize !== 0) {
          actionType = delta.targetSize > 0 ? "🟢 开多仓" : "🔴 开空仓";
        } else if (delta.targetSize === 0) {
          actionType = "⬜ 平仓";
        } else if (Math.sign(currentSize) === Math.sign(delta.targetSize)) {
          actionType = Math.abs(delta.targetSize) > Math.abs(currentSize) 
            ? (delta.targetSize > 0 ? "🟢 加多仓" : "🔴 加空仓")
            : (delta.targetSize > 0 ? "🟡 减多仓" : "🟡 减空仓");
        } else {
          actionType = delta.targetSize > 0 ? "🔄 空转多" : "🔄 多转空";
        }
        
        this.log.info("Copy trade decision", {
          coin: delta.coin,
          action: actionType,
          leaderEquity: "$" + leaderMetrics.accountValueUsd.toFixed(2),
          followerEquity: "$" + followerMetrics.accountValueUsd.toFixed(2),
          followerAddress: this.deps.followerAddress,
          currentSize: currentSize.toFixed(6),
          targetSize: delta.targetSize.toFixed(6),
          deltaSize: delta.deltaSize.toFixed(6),
          notionalUsd: "$" + notionalUsd.toFixed(2),
          markPrice: markPx,
        });
      }

      // Sync leverage for coins that are being opened (not already in follower's positions)
      // This ensures follower uses same leverage as leader for new positions
      if (this.syncLeverage) {
        for (const delta of processedDeltas) {
          const currentSize = delta.current?.size ?? 0;
          // Only sync leverage when opening a new position (currentSize ≈ 0)
          if (Math.abs(currentSize) < MIN_ABS_DELTA) {
            // Find the target for this coin to get leader's leverage settings
            const target = targets.find((t) => t.coin === delta.coin);
            if (target && target.leaderLeverageSetting > 0) {
              const metadata = this.deps.metadataService.getByCoin(delta.coin);
              if (metadata) {
                await this.syncLeverageForCoin(
                  metadata.assetId,
                  delta.coin,
                  target.leaderLeverageSetting,
                  target.leaderLeverageType === "cross",
                );
              }
            }
          }
        }
      }

      // Build orders for each actionable delta
      const orders = processedDeltas
        .map((delta) => this.buildOrder(delta))
        // Filter out orders that round to zero size (too small to trade)
        .filter((order) => {
          const size = parseFloat(order.s);
          if (size === 0 || !isFinite(size)) {
            this.log.debug(`Skipping zero-size order for asset ${order.a}`);
            return false;
          }
          return true;
        });

      if (orders.length === 0) {
        this.log.debug("No valid orders to submit after filtering");
        return;
      }

      this.log.info("Submitting orders to exchange", {
        orderCount: orders.length,
        details: orders.map((o) => ({
          asset: o.a,
          side: o.b ? "买入" : "卖出",
          size: o.s,
          price: o.p,
          reduceOnly: o.r,
        })),
      });

      // Submit all orders as a batch (no grouping)
      try {
        const response = await this.deps.exchangeClient.order({
          orders,
          grouping: "na",
        });

        // Log successful fills and any errors
        const statuses = response.response.data.statuses;
        const filled = statuses.filter((s) => "filled" in s || "resting" in s);
        const errors = statuses.filter((s) => "error" in s);

        if (filled.length > 0) {
          this.log.info("Orders executed successfully", { count: filled.length });
        }
        if (errors.length > 0) {
          this.log.warn("Some orders failed", {
            errorCount: errors.length,
            errors: errors.map((e) => ("error" in e ? e.error : "unknown")),
          });
        }
      } catch (error: unknown) {
        // Log the error but don't crash - margin errors are expected
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("Insufficient margin")) {
          this.log.warn("Order sync partially failed due to insufficient margin", { error: errorMessage });
        } else {
          this.log.error("Failed to synchronize follower with leader", { error });
        }
      }
    } catch (error) {
      this.log.error("Trade sync error", { error });
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Builds a Hyperliquid order from a position delta.
   *
   * Order characteristics:
   * - Type: IOC (Immediate-Or-Cancel) limit order
   * - Price: Mark price adjusted for slippage (higher for buys, lower for sells)
   * - Size: Absolute value of delta size, rounded to asset's size decimals
   * - Reduce-only: Set when closing or reducing a position
   *
   * @param delta - Position delta to execute
   * @returns Hyperliquid order object
   */
  private buildOrder(delta: PositionDelta) {
    const { risk, metadataService } = this.deps;
    const metadata = metadataService.requireByCoin(delta.coin);

    // Use mark price, fallback to current entry price
    const markPrice = metadataService.getMarkPrice(delta.coin) ?? delta.current?.entryPrice;

    if (!markPrice || markPrice <= 0) {
      throw new Error(`Cannot build order for ${delta.coin}: no valid mark price available`);
    }

    const sideIsBuy = delta.deltaSize > 0;

    // Convert slippage from basis points to decimal (e.g., 25 bps = 0.0025)
    const slippage = risk.maxSlippageBps / 10_000;

    // Adjust price for slippage: higher for buys (worse fill), lower for sells
    const priceMultiplier = sideIsBuy ? 1 + slippage : 1 - slippage;

    // Clamp price to reasonable bounds (10% to 1000% of mark price)
    const price = clamp(markPrice * priceMultiplier, markPrice * 0.1, markPrice * 10);

    const size = Math.abs(delta.deltaSize);

    // Determine if this order should be reduce-only
    const reduceOnly = (() => {
      if (!delta.current) {
        // Opening a new position, not reduce-only
        return false;
      }
      const currentSize = delta.current.size;
      const targetSize = delta.targetSize;

      // If target is zero (or dust), we're closing the position
      if (Math.abs(targetSize) < MIN_ABS_DELTA) {
        return true;
      }

      // If position direction stays the same but size decreases, it's a reduction
      const sameDirection = Math.sign(currentSize) === Math.sign(targetSize);
      return sameDirection && Math.abs(targetSize) < Math.abs(currentSize);
    })();

    // Round price to match mark price precision (Hyperliquid's tick size)
    const priceStr = roundToMarkPricePrecision(price, markPrice);

    // Build Hyperliquid order object
    return {
      a: metadata.assetId, // asset
      b: sideIsBuy, // is buy
      p: priceStr, // price
      s: size.toFixed(metadata.sizeDecimals), // size
      r: reduceOnly, // reduce-only flag
      t: {
        limit: {
          tif: "Ioc" as const, // Immediate-Or-Cancel
        },
      },
      c: `0x${randomUUID().replace(/-/g, "").slice(0, 32)}`, // client order ID
    };
  }
}
