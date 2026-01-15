#!/usr/bin/env node
/**
 * Hyperliquid Multi-Pair Copy Trading Agent
 *
 * This agent automatically replicates trades from leader accounts to follower accounts
 * on Hyperliquid DEX, with configurable risk management and position scaling.
 *
 * Key features:
 * - Multi-pair support: Multiple leader-follower pairs in a single process
 * - Proportional copy trading: Copy based on leader's leverage ratio
 * - Historical position tracking: Don't copy pre-existing positions
 * - Debounced sync: Handle rapid fills efficiently
 * - State persistence: Survive restarts gracefully
 *
 * Usage modes:
 * 1. Multi-pair mode: Set CONFIG_PATH env var or use config/pairs.json
 * 2. Single-pair mode (legacy): Use environment variables directly
 */

import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import * as dotenv from "dotenv";
import { loadConfig } from "./config/index.js";
import { loadConfigFromFile, getDefaultConfigPath, getEnabledPairs } from "./config/loader.js";
import { CopyTradingOrchestrator } from "./core/orchestrator.js";
import { createHyperliquidClients } from "./clients/hyperliquid.js";
import { LeaderState } from "./domain/leaderState.js";
import { FollowerState } from "./domain/followerState.js";
import { MarketMetadataService } from "./services/marketMetadata.js";
import { TradeExecutor } from "./services/tradeExecutor.js";
import { Reconciler } from "./services/reconciler.js";
import { SubscriptionService } from "./services/subscriptions.js";
import { logger } from "./utils/logger.js";

/**
 * Determines if multi-pair mode should be used.
 * Returns true if a config file exists or CONFIG_PATH is set.
 */
function shouldUseMultiPairMode(): boolean {
  const configPath = getDefaultConfigPath();
  return existsSync(configPath) || !!process.env.CONFIG_PATH;
}

/**
 * Runs the agent in multi-pair mode using JSON configuration.
 */
async function runMultiPairMode(): Promise<void> {
  const configPath = getDefaultConfigPath();
  logger.info("Loading multi-pair configuration", { configPath });

  const config = loadConfigFromFile(configPath);
  const enabledPairs = getEnabledPairs(config);

  if (enabledPairs.length === 0) {
    logger.error("No enabled pairs found in configuration");
    process.exit(1);
  }

  logger.info("Multi-pair mode initialized", {
    environment: config.environment,
    totalPairs: config.pairs.length,
    enabledPairs: enabledPairs.length,
    pairIds: enabledPairs.map((p) => p.id),
  });

  // Create and start orchestrator
  const orchestrator = new CopyTradingOrchestrator(config);

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}, shutting down`);
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Start orchestrator
  await orchestrator.start();

  // Log status periodically
  const statusInterval = setInterval(() => {
    const status = orchestrator.getStatus();
    logger.debug("Orchestrator status", {
      running: status.runningInstances,
      total: status.enabledPairs,
    });
  }, 60_000);

  // Keep process alive
  process.on("beforeExit", () => {
    clearInterval(statusInterval);
  });
}

/**
 * Runs the agent in single-pair mode using environment variables.
 * This is the legacy mode for backward compatibility.
 */
async function runSinglePairMode(): Promise<void> {
  logger.info("Running in single-pair mode (legacy)");

  // Load configuration from environment variables
  const config = loadConfig();

  // Initialize Hyperliquid API clients (HTTP + WebSocket)
  const clients = createHyperliquidClients(config);

  // State stores for leader and follower positions
  const leaderState = new LeaderState();
  const followerState = new FollowerState();

  // Service to fetch and cache market metadata (decimals, max leverage, etc.)
  const metadataService = new MarketMetadataService(clients.infoClient, logger);

  // Core service that computes deltas and executes follower orders
  const tradeExecutor = new TradeExecutor({
    exchangeClient: clients.exchangeClient,
    infoClient: clients.infoClient,
    followerAddress: clients.followerTradingAddress,
    leaderState,
    followerState,
    metadataService,
    risk: config.risk,
    log: logger,
  });

  // Periodic reconciliation service to sync full account state from Hyperliquid API
  const reconciler = new Reconciler(
    clients.infoClient,
    config,
    leaderState,
    followerState,
    clients.followerTradingAddress,
    logger,
  );

  // WebSocket subscription service for real-time leader fill updates
  const subscriptions = new SubscriptionService(
    clients.subscriptionClient,
    config,
    leaderState,
    () => tradeExecutor.syncWithLeader(),
    logger,
  );

  // Start WebSocket subscriptions to leader fills
  await subscriptions.start();

  // Perform initial reconciliation to sync state
  await reconciler.reconcileOnce();

  // Start periodic reconciliation loop
  reconciler.start();

  /**
   * Background polling loop to periodically sync follower with leader.
   * This provides a fallback in case WebSocket events are missed.
   */
  const pollLoop = async () => {
    while (true) {
      await tradeExecutor.syncWithLeader().catch((error) => {
        logger.error("Periodic sync failed", { error });
      });
      await delay(config.refreshAccountIntervalMs);
    }
  };

  void pollLoop();

  /**
   * Graceful shutdown handler for SIGINT/SIGTERM signals.
   * Unsubscribes from WebSocket channels and closes connections cleanly.
   */
  const shutdown = async (signal: string) => {
    logger.warn(`Received ${signal}, shutting down`);
    await subscriptions.stop().catch((error) => logger.error("Failed to stop subscriptions cleanly", { error }));
    reconciler.stop();
    await clients.wsTransport.close().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Main entry point for the copy trading agent.
 * Automatically selects multi-pair or single-pair mode based on configuration.
 */
async function main() {
  try {
    // Load environment variables from .env if present
    dotenv.config();

    logger.info("Hyperliquid Copy Trading Agent starting", {
      version: "2.0.0",
      nodeVersion: process.version,
    });

    // Determine which mode to run
    if (shouldUseMultiPairMode()) {
      await runMultiPairMode();
    } else {
      await runSinglePairMode();
    }
  } catch (error) {
    logger.error("Fatal error in copy trading agent", { error });
    process.exit(1);
  }
}

void main();
