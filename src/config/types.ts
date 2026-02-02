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

  /**
   * 趋势偏移系数（用于智能订单模式的 Maker 定价策略）
   * 
   * 仅在智能订单模式（enableSmartOrder: true）下生效。
   * 
   * 当满足趋势条件时使用激进偏移：
   * - 加仓 + 被套：顺趋势偏移（DCA 抄底/逃顶，趋势延续概率高）
   * - 减仓 + 盈利：顺趋势偏移（止盈场景，趋势延续概率高）
   * 
   * 偏移量计算：
   * - priceDiff = |markPrice - entryPrice|（当前浮动幅度）
   * - trendOffset = priceDiff × trendOffsetMultiplier
   * 
   * 挂单价格：
   * - 买入（市场下跌）：bestBid - trendOffset（买更便宜）
   * - 卖出（市场上涨）：bestAsk + trendOffset（卖更贵）
   * 
   * 值越大，挂单越激进：
   * - 0.1 = 偏移 priceDiff 的 10%（保守）
   * - 0.3 = 偏移 priceDiff 的 30%（推荐，风险收益平衡）
   * - 0.5 = 偏移 priceDiff 的 50%（激进）
   * 
   * 风险说明：
   * - 值越大，成交等待时间越长，但潜在收益更高
   * - 未成交订单由对账机制兜底
   * - 设为 0 则回退到保守策略（使用 bestBid/bestAsk）
   * 
   * @default 0.3
   */
  trendOffsetMultiplier?: number;

  /**
   * 减仓限价单超时时间（毫秒）
   * 
   * 仅在智能订单模式（enableSmartOrder: true）下生效。
   * 
   * 减仓限价单超时后的处理：
   * 1. 取消超时的减仓限价单
   * 2. 立即执行市价减仓（确保风险控制）
   * 
   * 为什么减仓需要超时处理：
   * - 减仓是风险控制行为，领航员减仓通常是为了降低风险
   * - 限价单未成交意味着跟单者风险敞口未降低
   * - 市价补单确保减仓执行，与领航员保持同步
   * 
   * 与加仓的区别：
   * - 加仓限价单不设超时（保持现状，由对账机制兜底）
   * - 减仓限价单超时后自动市价补单
   * 
   * 设为 0 禁用超时检查（减仓限价单将一直挂单）
   * 
   * @default 180000 (3分钟)
   */
  reduceOrderTimeoutMs?: number;
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

  // ==================== 智能订单模式配置 ====================

  /**
   * 是否启用智能订单模式（Smart Order Mode）
   * 
   * 智能订单模式根据交易类型自动选择订单类型：
   * - 新开仓/平仓/反向开仓 → 使用市价单（IOC），确保及时成交
   * - 加仓/减仓 → 使用限价单（GTC），享受 Maker 费率（0.015% vs 0.045%）
   * 
   * 优点：
   * - 开仓/平仓确保及时成交（市价单）
   * - 加仓/减仓降低手续费（限价单 Maker 费率）
   * - 限价单未成交由对账机制兜底
   * - 频繁加减仓场景手续费降低 40-60%
   * 
   * 适用场景：
   * - 领航员频繁加仓/减仓
   * - 希望优化手续费
   * 
   * 建议配置：
   * - 启用时建议 syncDebounceMs 设为 1000-2000ms（聚合更多操作）
   * 
   * @default false
   */
  enableSmartOrder?: boolean;
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
      trendOffsetMultiplier: 0.3,       // 趋势偏移系数，推荐 0.3
      reduceOrderTimeoutMs: 180_000,    // 减仓限价单超时 3 分钟
    },
    // 智能订单模式默认配置
    enableSmartOrder: false,
  },
} as const;
