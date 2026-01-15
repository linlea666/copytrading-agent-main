/**
 * Configuration types for multi-pair copy trading system.
 *
 * Supports multiple leader-follower pairs with independent configurations.
 */

/** Hyperliquid network environment */
export type HyperliquidEnvironment = "mainnet" | "testnet";

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
   * Private key of the follower account (hex format with 0x prefix).
   * Can use ${ENV_VAR_NAME} syntax for environment variable substitution.
   */
  followerPrivateKey: `0x${string}`;

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
}

/**
 * Global configuration for the multi-pair copy trading system.
 */
export interface MultiCopyTradingConfig {
  /** Hyperliquid network to connect to */
  environment: HyperliquidEnvironment;

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

  /** List of copy trading pairs */
  pairs: CopyPairConfig[];
}

/**
 * Default values for optional configuration fields.
 */
export const CONFIG_DEFAULTS = {
  environment: "mainnet" as HyperliquidEnvironment,
  reconciliationIntervalMs: 60_000,
  refreshAccountIntervalMs: 5_000,
  websocketAggregateFills: true,
  stateDir: "./data/state",
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
    },
  },
} as const;
