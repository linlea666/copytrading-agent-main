/**
 * Domain types for trader state and position snapshots.
 */

/** Direction of a position */
export type PositionSide = "long" | "short" | "flat";

/**
 * Trading direction from Hyperliquid fill's `dir` field.
 */
export type TradingDirection =
  | "Open Long"
  | "Close Long"
  | "Open Short"
  | "Close Short";

/**
 * Parsed and aggregated trading signal from leader's fills.
 */
export interface TradingSignal {
  /** Trading pair (e.g., "BTC", "ETH") */
  coin: string;
  /** Trading direction from fill's dir field */
  direction: TradingDirection;
  /** Total size (aggregated if multiple fills for same oid) */
  size: number;
  /** Average price (weighted if aggregated) */
  price: number;
  /** Order ID for aggregation */
  orderId: number;
  /** Position size before execution */
  startPosition: number;
  /** Position size after execution */
  endPosition: number;
  /** Timestamp of the fill */
  timestamp: number;
  /** Whether this was a taker order (crossed the spread) */
  crossed: boolean;
  /** Whether this is a new position (startPosition was 0) */
  isNewPosition: boolean;
  /** Whether this fully closes the position (endPosition is 0) */
  isFullClose: boolean;
}

/**
 * Result of processing a trading signal.
 */
export interface CopyAction {
  /** Trading pair */
  coin: string;
  /** Action to execute: buy or sell */
  action: "buy" | "sell";
  /** Size to trade */
  size: number;
  /** Reference price for slippage calculation */
  price: number;
  /** Whether this should be reduce-only */
  reduceOnly: boolean;
  /** Human-readable description of the action */
  description: string;
}

/** Leverage mode type */
export type LeverageType = "cross" | "isolated";

/**
 * Immutable snapshot of a position at a point in time.
 */
export interface PositionSnapshot {
  /** Trading pair identifier (e.g., "BTC", "ETH") */
  coin: string;
  /** Position size: positive for long, negative for short, 0 for flat */
  size: number;
  /** Average entry price for the position */
  entryPrice: number;
  /** Current position value in USD (abs(size) * markPrice) */
  positionValueUsd: number;
  /** Current leverage multiplier (e.g., 40 for 40x) */
  leverage: number;
  /** Leverage type: "cross" or "isolated" */
  leverageType: LeverageType;
  /** Margin currently allocated to this position in USD */
  marginUsedUsd: number;
  /** Estimated liquidation price, null if not available */
  liquidationPrice?: number | null;
  /** Timestamp of last update in milliseconds */
  lastUpdatedMs: number;
}

/**
 * Account-level metrics for a trader.
 */
export interface AccountMetrics {
  /** Total account value (equity) in USD */
  accountValueUsd: number;
  /** Total notional position value in USD across all positions */
  totalNotionalUsd: number;
  /** Total margin currently in use across all positions */
  totalMarginUsedUsd: number;
  /** Amount available for withdrawal in USD */
  withdrawableUsd: number;
  /** Timestamp of last update in milliseconds */
  lastUpdatedMs: number;
}

/**
 * Complete state for a trader account.
 */
export interface TraderState {
  /** Map of coin symbol to position snapshot */
  positions: Map<string, PositionSnapshot>;
  /** Account-level metrics */
  metrics: AccountMetrics;
}
