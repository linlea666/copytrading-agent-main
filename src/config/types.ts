/**
 * Configuration types for multi-pair copy trading system.
 *
 * Supports multiple leader-follower pairs with independent configurations.
 */

/** Hyperliquid network environment */
export type HyperliquidEnvironment = "mainnet" | "testnet";

/** Log level for controlling output verbosity */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Risk management parameters for a single copy trading pair.
 */
export interface PairRiskConfig {
  /**
   * Copy ratio multiplier for position sizing.
   * - 1.0 = 100% (mirror leader's leverage ratio exactly)
   * - 0.5 = 50% (half the leader's leverage ratio)
   * - 2.0 = 200% (double the leader's leverage ratio)
   *
   * Formula: follower_notional = leader_leverage × copyRatio × follower_equity
   */
  copyRatio: number;

  /** Maximum leverage allowed for follower positions (hard cap) */
  maxLeverage: number;

  /** Maximum notional USD value for any single follower position */
  maxNotionalUsd: number;

  /** Maximum slippage in basis points (e.g., 25 = 0.25%) */
  maxSlippageBps: number;

  /** When true, invert leader direction (long→short, short→long) */
  inverse: boolean;

  /**
   * Maximum allowed position deviation percentage between leader and follower.
   * 
   * When the difference in position ratio (position_value / account_equity) between
   * leader and follower exceeds this threshold, sync will be forced regardless of
   * minimum order notional. This prevents position drift when leader has much larger
   * account than follower.
   * 
   * Example: If set to 5, and leader has 10% of equity in BTC but follower has only 3%,
   * the 7% deviation exceeds the 5% threshold, forcing a sync even if the order
   * notional is below minOrderNotionalUsd.
   * 
   * Set to 0 to disable deviation-based forced sync.
   * @default 5 (5%)
   */
  maxPositionDeviationPercent?: number;

  /**
   * Slippage tolerance for market orders (as decimal, e.g., 0.05 = 5%).
   * 
   * Market orders are executed as aggressive limit orders with IOC (Immediate or Cancel).
   * This slippage determines the price limit:
   * - Buy: midPrice × (1 + slippage)
   * - Sell: midPrice × (1 - slippage)
   * 
   * @default 0.05 (5%, matches official SDK)
   */
  marketOrderSlippage?: number;

  /**
   * Price deviation threshold for boosting add-position orders (as decimal).
   * 
   * When an add-position order needs to be boosted to meet minimum notional,
   * this threshold determines if the current price is favorable enough to execute:
   * - Long: skip if currentPrice > leaderPrice × (1 + threshold)
   * - Short: skip if currentPrice < leaderPrice × (1 - threshold)
   * 
   * Only applies to add-position orders (not new positions or reversals).
   * 
   * @default 0.0005 (0.05%, about $50 for BTC at $100k)
   */
  boostPriceThreshold?: number;
}

/**
 * Configuration for a single leader-follower copy trading pair.
 */
export interface CopyPairConfig {
  /** Unique identifier for this pair (used in logs and state files) */
  id: string;

  /** Ethereum address of the leader account to copy */
  leaderAddress: `0x${string}`;

  /**
   * Private key of the follower account or API wallet (hex format with 0x prefix).
   * Can use ${ENV_VAR_NAME} syntax for environment variable substitution.
   * 
   * If using an API wallet (proxy wallet), this should be the API wallet's private key,
   * and followerAddress should be set to the main account address.
   */
  followerPrivateKey: `0x${string}`;

  /**
   * Main account address for the follower (used for querying state and submitting orders).
   * 
   * Required when using an API wallet (proxy wallet):
   * - followerPrivateKey: API wallet's private key (for signing)
   * - followerAddress: Main account address (for trading)
   * 
   * If not specified, the address will be derived from followerPrivateKey.
   */
  followerAddress?: `0x${string}`;

  /** Optional vault address if trading through a Hyperliquid vault */
  followerVaultAddress?: `0x${string}`;

  /** Risk management parameters */
  risk: PairRiskConfig;

  /**
   * Minimum order notional in USD.
   * Orders below this threshold will be skipped.
   * Recommended: 12-20 (Hyperliquid minimum is $10)
   * @default 15
   */
  minOrderNotionalUsd: number;

  /**
   * Debounce delay in milliseconds for sync operations.
   * When leader executes multiple fills rapidly, wait this long
   * after the last fill before executing a single sync.
   * @default 300
   */
  syncDebounceMs: number;

  /** Whether this pair is enabled for copy trading */
  enabled: boolean;

  // ==================== 混合模式配置（双订阅+智能去重） ====================

  /**
   * 是否启用混合模式（Hybrid Mode）
   * 
   * 混合模式同时订阅 openOrders（限价单挂单）和 userFills（成交信号）：
   * - 领航员挂限价单 → 跟单者也挂限价单（享受 Maker 费率）
   * - 领航员市价单成交 → 跟单者使用市价单跟随（实时跟单）
   * - 通过 oid 智能去重，避免重复跟单
   * 
   * 优点：
   * - 限价单享受 Maker 低费率
   * - 市价单实时跟随不延迟
   * - 100% 捕获率（限价单+市价单都能跟）
   * 
   * 适用场景：
   * - 领航员混合使用限价单和市价单
   * - 希望优化手续费同时保证实时性
   * 
   * @default false
   */
  enableHybridMode?: boolean;

  /**
   * 混合模式专用配置
   */
  hybridConfig?: {
    /**
     * Fill 聚合窗口（毫秒）
     * 同一订单的多笔成交在此窗口内聚合为一笔跟单
     * @default 500
     */
    fillAggregationWindowMs?: number | undefined;
  } | undefined;
}

/**
 * Global configuration for the multi-pair copy trading system.
 */
export interface MultiCopyTradingConfig {
  /** Hyperliquid network to connect to */
  environment: HyperliquidEnvironment;

  /**
   * Log level for controlling output verbosity.
   * - "debug": Detailed diagnostic information (recommended for troubleshooting)
   * - "info": General operational messages (default)
   * - "warn": Warning messages only
   * - "error": Error messages only
   * @default "info"
   */
  logLevel: LogLevel;

  /**
   * Interval in milliseconds for periodic full state reconciliation.
   * @default 60000
   */
  reconciliationIntervalMs: number;

  /**
   * Interval in milliseconds for background sync polling.
   * @default 5000
   */
  refreshAccountIntervalMs: number;

  /**
   * Whether to aggregate fills by time in WebSocket subscriptions.
   * @default true
   */
  websocketAggregateFills: boolean;

  /**
   * Directory path for persisting pair state files.
   * @default "./data/state"
   */
  stateDir: string;

  /**
   * Whether to enable trade logging to files.
   * When enabled, trade logs will be saved to stateDir/trades/{leaderAddress}/{date}.jsonl
   * @default true
   */
  enableTradeLog?: boolean;

  /** List of copy trading pairs */
  pairs: CopyPairConfig[];
}

/**
 * Default values for optional configuration fields.
 */
export const CONFIG_DEFAULTS = {
  environment: "mainnet" as HyperliquidEnvironment,
  logLevel: "info" as LogLevel,
  reconciliationIntervalMs: 60_000,  // 60秒对账间隔
  refreshAccountIntervalMs: 5_000,
  websocketAggregateFills: true,
  stateDir: "./data/state",
  enableTradeLog: true,
  pair: {
    minOrderNotionalUsd: 15,
    syncDebounceMs: 300,
    enabled: true,
    risk: {
      copyRatio: 1.0,
      maxLeverage: 10,
      maxNotionalUsd: 250_000,
      maxSlippageBps: 25,
      inverse: false,
      maxPositionDeviationPercent: 5,
      marketOrderSlippage: 0.05,
      boostPriceThreshold: 0.0005,
    },
    // 混合模式默认配置
    enableHybridMode: false,
    hybridConfig: {
      fillAggregationWindowMs: 500,
    },
  },
} as const;
