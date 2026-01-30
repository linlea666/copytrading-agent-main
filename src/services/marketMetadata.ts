/**
 * Service for fetching and caching Hyperliquid market metadata.
 *
 * Maintains:
 * - Asset metadata (asset IDs, size decimals, max leverage)
 * - Current mark prices for all assets
 * - Order book data (best bid/ask) for smart order execution
 *
 * Metadata is loaded once on initialization and mark prices can be refreshed periodically.
 */

import type * as hl from "@nktkas/hyperliquid";
import { logger, type Logger } from "../utils/logger.js";

/**
 * Metadata for a single trading pair.
 */
export interface AssetMetadata {
  /** Numeric asset ID used in Hyperliquid API calls */
  assetId: number;
  /** Human-readable coin symbol (e.g., "BTC", "ETH") */
  coin: string;
  /** Maximum allowed leverage for this asset */
  maxLeverage: number;
  /** Number of decimal places for position size */
  sizeDecimals: number;
  /** ID of the margin tier table for this asset */
  marginTableId: number;
}

/**
 * Order book data for a single coin.
 */
export interface OrderBookData {
  /** Best bid price (highest buy order) */
  bestBid: number;
  /** Best ask price (lowest sell order) */
  bestAsk: number;
  /** Timestamp of the data */
  timestamp: number;
}

/**
 * Caches market metadata and mark prices for efficient order construction.
 */
export class MarketMetadataService {
  private loaded = false;
  private readonly coinToMeta = new Map<string, AssetMetadata>();
  private readonly coinToMarkPx = new Map<string, number>();
  private readonly coinToMidPx = new Map<string, number>();
  private readonly coinToOrderBook = new Map<string, OrderBookData>();

  constructor(private readonly infoClient: hl.InfoClient, private readonly log: Logger = logger) {}

  /**
   * Ensures market metadata is loaded, fetching from API if needed.
   * Safe to call multiple times (no-op if already loaded).
   *
   * @param signal - Optional abort signal to cancel the request
   */
  async ensureLoaded(signal?: AbortSignal) {
    if (this.loaded) {
      return;
    }
    const [meta, contexts] = await this.infoClient.metaAndAssetCtxs(undefined, signal);
    meta.universe.forEach((entry, index) => {
      const metadata: AssetMetadata = {
        assetId: index,
        coin: entry.name,
        maxLeverage: entry.maxLeverage,
        sizeDecimals: entry.szDecimals,
        marginTableId: entry.marginTableId,
      };
      this.coinToMeta.set(entry.name, metadata);
      const ctx = contexts[index];
      if (ctx) {
        this.coinToMarkPx.set(entry.name, Number(ctx.markPx));
      }
    });
    this.loaded = true;
    this.log.info("Loaded Hyperliquid market metadata", { assets: this.coinToMeta.size });
  }

  /**
   * Gets metadata for a coin, returning undefined if not found.
   */
  getByCoin(coin: string): AssetMetadata | undefined {
    return this.coinToMeta.get(coin);
  }

  /**
   * Gets metadata for a coin, throwing if not found.
   * @throws {Error} If the coin is not in the metadata cache
   */
  requireByCoin(coin: string): AssetMetadata {
    const metadata = this.getByCoin(coin);
    if (!metadata) {
      throw new Error(`Unknown coin ${coin} in market metadata`);
    }
    return metadata;
  }

  /**
   * Gets the current mark price for a coin.
   */
  getMarkPrice(coin: string): number | undefined {
    return this.coinToMarkPx.get(coin);
  }

  /**
   * Gets the current mid price (order book mid) for a coin.
   * Mid price = (best bid + best ask) / 2
   */
  getMidPrice(coin: string): number | undefined {
    return this.coinToMidPx.get(coin);
  }

  /**
   * Gets the best available price for order execution.
   * Priority: mid price > mark price
   * 
   * Mid price is preferred as it reflects actual order book state,
   * matching the official SDK's market order implementation.
   */
  getExecutionPrice(coin: string): number | undefined {
    return this.coinToMidPx.get(coin) ?? this.coinToMarkPx.get(coin);
  }

  /**
   * Fetches and caches all mid prices from the API.
   * Mid prices represent the midpoint between best bid and ask.
   *
   * @param signal - Optional abort signal to cancel the request
   */
  async refreshMidPrices(signal?: AbortSignal): Promise<void> {
    try {
      const mids = await this.infoClient.allMids(undefined, signal);
      for (const [coin, price] of Object.entries(mids)) {
        const numPrice = typeof price === "string" ? parseFloat(price) : price;
        if (!isNaN(numPrice) && numPrice > 0) {
          this.coinToMidPx.set(coin, numPrice);
        }
      }
      this.log.debug("Refreshed mid prices", { count: this.coinToMidPx.size });
    } catch (error) {
      this.log.warn("Failed to refresh mid prices", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Refreshes mark prices from the API without reloading metadata.
   * If metadata is not yet loaded, performs a full load instead.
   *
   * @param signal - Optional abort signal to cancel the request
   */
  async refreshMarkPrices(signal?: AbortSignal) {
    if (!this.loaded) {
      await this.ensureLoaded(signal);
      return;
    }
    const [meta, contexts] = await this.infoClient.metaAndAssetCtxs(undefined, signal);
    meta.universe.forEach((entry, index) => {
      const ctx = contexts[index];
      if (ctx) {
        this.coinToMarkPx.set(entry.name, Number(ctx.markPx));
      }
    });
    this.log.debug("Refreshed mark prices");
  }

  /**
   * Fetches L2 order book for a specific coin and caches best bid/ask.
   * Used for smart Maker limit order pricing.
   *
   * @param coin - Asset symbol (e.g., "BTC")
   * @param signal - Optional abort signal to cancel the request
   * @returns Order book data or undefined if fetch fails
   */
  async refreshOrderBook(coin: string, signal?: AbortSignal): Promise<OrderBookData | undefined> {
    try {
      const book = await this.infoClient.l2Book({ coin }, signal);
      if (!book || !book.levels) {
        this.log.debug("No order book data", { coin });
        return undefined;
      }

      const [bids, asks] = book.levels;

      // bids[0] = highest bid, asks[0] = lowest ask
      const topBid = bids[0];
      const topAsk = asks[0];
      if (!topBid || !topAsk) {
        this.log.debug("Empty order book", { coin });
        return undefined;
      }

      // L2BookLevelSchema: { px: string, sz: string, n: number }
      const bestBid = parseFloat(topBid.px);
      const bestAsk = parseFloat(topAsk.px);

      if (isNaN(bestBid) || isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
        this.log.debug("Invalid order book prices", { coin, bestBid, bestAsk });
        return undefined;
      }

      const orderBookData: OrderBookData = {
        bestBid,
        bestAsk,
        timestamp: book.time,
      };

      this.coinToOrderBook.set(coin, orderBookData);
      this.log.debug("Refreshed order book", {
        coin,
        bestBid: "$" + bestBid.toFixed(2),
        bestAsk: "$" + bestAsk.toFixed(2),
        spread: ((bestAsk - bestBid) / bestBid * 100).toFixed(4) + "%",
      });

      return orderBookData;
    } catch (error) {
      this.log.warn("Failed to refresh order book", {
        coin,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Gets cached order book data for a coin.
   */
  getOrderBook(coin: string): OrderBookData | undefined {
    return this.coinToOrderBook.get(coin);
  }

  /**
   * Gets best bid price for a coin.
   */
  getBestBid(coin: string): number | undefined {
    return this.coinToOrderBook.get(coin)?.bestBid;
  }

  /**
   * Gets best ask price for a coin.
   */
  getBestAsk(coin: string): number | undefined {
    return this.coinToOrderBook.get(coin)?.bestAsk;
  }
}
