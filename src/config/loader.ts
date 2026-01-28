/**
 * Configuration loader for multi-pair copy trading system.
 *
 * Loads configuration from JSON file with environment variable substitution.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIG_DEFAULTS,
  type CopyPairConfig,
  type HyperliquidEnvironment,
  type LogLevel,
  type MultiCopyTradingConfig,
  type PairRiskConfig,
} from "./types.js";

/**
 * Substitutes ${ENV_VAR} patterns in a string with environment variable values.
 * @param value - String potentially containing ${ENV_VAR} patterns
 * @returns String with environment variables substituted
 * @throws {Error} If referenced environment variable is not set
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set (referenced in config)`);
    }
    return envValue;
  });
}

/**
 * Validates and normalizes a pair configuration with defaults.
 */
function normalizePairConfig(pair: Partial<CopyPairConfig>, index: number): CopyPairConfig {
  if (!pair.id) {
    throw new Error(`Pair at index ${index} is missing required field: id`);
  }
  if (!pair.leaderAddress) {
    throw new Error(`Pair "${pair.id}" is missing required field: leaderAddress`);
  }
  if (!pair.followerPrivateKey) {
    throw new Error(`Pair "${pair.id}" is missing required field: followerPrivateKey`);
  }

  // Substitute environment variables in private key
  const followerPrivateKey = substituteEnvVars(pair.followerPrivateKey) as `0x${string}`;
  if (!followerPrivateKey.startsWith("0x")) {
    throw new Error(`Pair "${pair.id}": followerPrivateKey must start with 0x`);
  }

  // Validate addresses
  const leaderAddress = pair.leaderAddress.toLowerCase() as `0x${string}`;
  if (leaderAddress.length !== 42) {
    throw new Error(`Pair "${pair.id}": leaderAddress must be 42 characters`);
  }

  // Validate follower address (main account address when using API wallet)
  let followerAddress: `0x${string}` | undefined;
  if (pair.followerAddress) {
    followerAddress = pair.followerAddress.toLowerCase() as `0x${string}`;
    if (followerAddress.length !== 42) {
      throw new Error(`Pair "${pair.id}": followerAddress must be 42 characters`);
    }
  }

  let followerVaultAddress: `0x${string}` | undefined;
  if (pair.followerVaultAddress) {
    followerVaultAddress = pair.followerVaultAddress.toLowerCase() as `0x${string}`;
    if (followerVaultAddress.length !== 42) {
      throw new Error(`Pair "${pair.id}": followerVaultAddress must be 42 characters`);
    }
  }

  // Merge risk config with defaults
  const risk: PairRiskConfig = {
    copyRatio: pair.risk?.copyRatio ?? CONFIG_DEFAULTS.pair.risk.copyRatio,
    maxLeverage: pair.risk?.maxLeverage ?? CONFIG_DEFAULTS.pair.risk.maxLeverage,
    maxNotionalUsd: pair.risk?.maxNotionalUsd ?? CONFIG_DEFAULTS.pair.risk.maxNotionalUsd,
    maxSlippageBps: pair.risk?.maxSlippageBps ?? CONFIG_DEFAULTS.pair.risk.maxSlippageBps,
    inverse: pair.risk?.inverse ?? CONFIG_DEFAULTS.pair.risk.inverse,
  };

  // Validate risk parameters
  if (risk.copyRatio <= 0) {
    throw new Error(`Pair "${pair.id}": copyRatio must be positive`);
  }
  if (risk.maxLeverage <= 0) {
    throw new Error(`Pair "${pair.id}": maxLeverage must be positive`);
  }

  return {
    id: pair.id,
    leaderAddress,
    followerPrivateKey,
    ...(followerAddress ? { followerAddress } : {}),
    ...(followerVaultAddress ? { followerVaultAddress } : {}),
    risk,
    minOrderNotionalUsd: pair.minOrderNotionalUsd ?? CONFIG_DEFAULTS.pair.minOrderNotionalUsd,
    syncDebounceMs: pair.syncDebounceMs ?? CONFIG_DEFAULTS.pair.syncDebounceMs,
    enabled: pair.enabled ?? CONFIG_DEFAULTS.pair.enabled,
    // 智能订单模式配置
    enableSmartOrder: pair.enableSmartOrder ?? CONFIG_DEFAULTS.pair.enableSmartOrder,
  };
}

/**
 * Loads and validates configuration from a JSON file.
 *
 * @param configPath - Path to the JSON configuration file
 * @returns Validated and normalized configuration
 * @throws {Error} If file doesn't exist, is invalid JSON, or fails validation
 */
export function loadConfigFromFile(configPath: string): MultiCopyTradingConfig {
  const resolvedPath = resolve(configPath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }

  let rawConfig: Record<string, unknown>;
  try {
    const content = readFileSync(resolvedPath, "utf-8");
    rawConfig = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse configuration file: ${message}`);
  }

  // Validate environment
  const environment = (rawConfig.environment as HyperliquidEnvironment) ?? CONFIG_DEFAULTS.environment;
  if (environment !== "mainnet" && environment !== "testnet") {
    throw new Error(`Invalid environment: ${environment}. Must be "mainnet" or "testnet"`);
  }

  // Validate log level (can also be overridden by LOG_LEVEL env var)
  const configLogLevel = rawConfig.logLevel as LogLevel | undefined;
  const envLogLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const logLevel = envLogLevel ?? configLogLevel ?? CONFIG_DEFAULTS.logLevel;
  const validLogLevels: LogLevel[] = ["debug", "info", "warn", "error"];
  if (!validLogLevels.includes(logLevel)) {
    throw new Error(`Invalid logLevel: ${logLevel}. Must be one of: ${validLogLevels.join(", ")}`);
  }

  // Validate pairs array
  const rawPairs = rawConfig.pairs;
  if (!Array.isArray(rawPairs) || rawPairs.length === 0) {
    throw new Error("Configuration must include at least one pair in the 'pairs' array");
  }

  // Normalize each pair
  const pairs = rawPairs.map((pair, index) => normalizePairConfig(pair as Partial<CopyPairConfig>, index));

  // Check for duplicate pair IDs
  const pairIds = new Set<string>();
  for (const pair of pairs) {
    if (pairIds.has(pair.id)) {
      throw new Error(`Duplicate pair ID: ${pair.id}`);
    }
    pairIds.add(pair.id);
  }

  // Check for duplicate leader addresses within same follower
  const leaderFollowerPairs = new Set<string>();
  for (const pair of pairs) {
    const key = `${pair.leaderAddress}:${pair.followerPrivateKey.slice(0, 10)}`;
    if (leaderFollowerPairs.has(key)) {
      throw new Error(`Duplicate leader-follower pair detected for leader: ${pair.leaderAddress}`);
    }
    leaderFollowerPairs.add(key);
  }

  return {
    environment,
    logLevel,
    reconciliationIntervalMs:
      (rawConfig.reconciliationIntervalMs as number) ?? CONFIG_DEFAULTS.reconciliationIntervalMs,
    refreshAccountIntervalMs:
      (rawConfig.refreshAccountIntervalMs as number) ?? CONFIG_DEFAULTS.refreshAccountIntervalMs,
    websocketAggregateFills:
      (rawConfig.websocketAggregateFills as boolean) ?? CONFIG_DEFAULTS.websocketAggregateFills,
    stateDir: (rawConfig.stateDir as string) ?? CONFIG_DEFAULTS.stateDir,
    pairs,
  };
}

/**
 * Returns the default configuration file path.
 * Checks for config/pairs.json relative to cwd.
 */
export function getDefaultConfigPath(): string {
  const envPath = process.env.CONFIG_PATH;
  if (envPath) {
    return resolve(envPath);
  }
  return resolve(process.cwd(), "config", "pairs.json");
}

/**
 * Gets enabled pairs from configuration.
 */
export function getEnabledPairs(config: MultiCopyTradingConfig): CopyPairConfig[] {
  return config.pairs.filter((pair) => pair.enabled);
}
