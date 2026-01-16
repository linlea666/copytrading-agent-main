/**
 * Trade execution utilities for copy trading.
 *
 * This module provides simple order execution helpers.
 * Main trading logic has been moved to SignalProcessor.
 *
 * @deprecated Most functionality moved to SignalProcessor.
 * This file is kept for backward compatibility and utility functions.
 */

import type * as hl from "@nktkas/hyperliquid";
import { randomUUID } from "node:crypto";
import type { RiskConfig } from "../config/index.js";
import type { PairRiskConfig } from "../config/types.js";
import { logger, type Logger } from "../utils/logger.js";
import { clamp } from "../utils/math.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import type { HistoryPositionTracker } from "../domain/historyTracker.js";
import { MarketMetadataService } from "./marketMetadata.js";

/** Default minimum order notional (USD) */
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 15;

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
  /** Risk configuration */
  risk: RiskConfig | PairRiskConfig;
  /** Minimum order notional in USD */
  minOrderNotionalUsd?: number;
  /** Historical position tracker */
  historyTracker?: HistoryPositionTracker;
  /** Whether to sync leverage settings with leader */
  syncLeverage?: boolean;
  /** Optional logger instance */
  log?: Logger;
}

/**
 * Simple trade executor for utility functions.
 * Main trading logic has been moved to SignalProcessor.
 */
export class TradeExecutor {
  private readonly log: Logger;
  private readonly minOrderNotionalUsd: number;
  private readonly syncLeverage: boolean;

  constructor(private readonly deps: TradeExecutorDeps) {
    this.log = deps.log ?? logger;
    this.minOrderNotionalUsd = deps.minOrderNotionalUsd ?? DEFAULT_MIN_ORDER_NOTIONAL_USD;
    this.syncLeverage = deps.syncLeverage ?? true;
  }

  /**
   * @deprecated Use SignalProcessor instead.
   * This method is kept for backward compatibility but does nothing.
   * Trading is now driven by WebSocket fill events via SignalProcessor.
   */
  async syncWithLeader(): Promise<void> {
    // No-op: Trading logic moved to SignalProcessor
    // This method is kept for backward compatibility
    this.log.debug("syncWithLeader called but disabled - use SignalProcessor");
  }

  /**
   * Execute a simple market order.
   * Utility function that can be used for manual interventions.
   */
  async executeMarketOrder(
    coin: string,
    side: "buy" | "sell",
    size: number,
    reduceOnly: boolean = false,
  ): Promise<void> {
    const metadata = this.deps.metadataService.getByCoin(coin);
    if (!metadata) {
      throw new Error(`No metadata for coin: ${coin}`);
    }

    const markPrice = this.deps.metadataService.getMarkPrice(coin);
    if (!markPrice || markPrice <= 0) {
      throw new Error(`No valid mark price for: ${coin}`);
    }

    // Calculate slippage price (3% for protection)
    const slippage = Math.max((this.deps.risk.maxSlippageBps ?? 300) / 10_000, 0.03);
    const priceMultiplier = side === "buy" ? 1 + slippage : 1 - slippage;
    const limitPrice = clamp(markPrice * priceMultiplier, markPrice * 0.1, markPrice * 10);
    const priceStr = roundToMarkPricePrecision(limitPrice, markPrice);
    const sizeStr = size.toFixed(metadata.sizeDecimals);

    this.log.info("Executing market order", {
      coin,
      side,
      size: sizeStr,
      price: priceStr,
      reduceOnly,
    });

    const order = {
      a: metadata.assetId,
      b: side === "buy",
      p: priceStr,
      s: sizeStr,
      r: reduceOnly,
      t: {
        limit: {
          tif: "FrontendMarket" as const,
        },
      },
      c: `0x${randomUUID().replace(/-/g, "").slice(0, 32)}`,
    };

    const response = await this.deps.exchangeClient.order({
      orders: [order],
      grouping: "na",
    });

    const statuses = response.response.data.statuses;
    const errors = statuses.filter((s) => "error" in s);

    if (errors.length > 0) {
      throw new Error(`Order failed: ${errors.map((e) => ("error" in e ? e.error : "unknown")).join(", ")}`);
    }

    this.log.info("Order executed", { coin, side, size: sizeStr });
  }

  /**
   * Sync leverage for a coin to match leader's settings.
   */
  async syncLeverageForCoin(coin: string): Promise<void> {
    if (!this.syncLeverage) return;

    const leaderPos = this.deps.leaderState.getPosition(coin);
    if (!leaderPos || leaderPos.leverage <= 0) return;

    const metadata = this.deps.metadataService.getByCoin(coin);
    if (!metadata) return;

    try {
      await this.deps.exchangeClient.updateLeverage({
        asset: metadata.assetId,
        isCross: leaderPos.leverageType === "cross",
        leverage: Math.floor(leaderPos.leverage),
      });
      this.log.info("Leverage synced", {
        coin,
        leverage: Math.floor(leaderPos.leverage),
      });
    } catch (error) {
      this.log.warn("Failed to sync leverage", {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
