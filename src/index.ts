#!/usr/bin/env node
/**
 * Hyperliquid Multi-Pair Copy Trading Agent
 *
 * This agent automatically replicates trades from leader accounts to follower accounts
 * on Hyperliquid DEX, with configurable risk management and position scaling.
 *
 * Key features:
 * - Multi-pair support: Multiple leader-follower pairs in a single process
 * - Signal-based copy trading: Directly follows leader's WebSocket fill events
 * - Accurate direction detection: Uses fill's `dir` field for trade type
 * - Order aggregation: Aggregates multiple fills by order ID for efficiency
 * - Historical position tracking: Don't copy pre-existing positions
 * - State persistence: Survive restarts gracefully
 *
 * Trading flow:
 * 1. WebSocket receives leader's fill events
 * 2. SignalProcessor parses direction, aggregates by order ID
 * 3. Copy trade executed with proportional sizing
 *
 * Usage modes:
 * 1. Multi-pair mode: Set CONFIG_PATH env var or use config/pairs.json
 * 2. Single-pair mode (legacy): Use environment variables directly
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { loadConfig } from "./config/index.js";
import { loadConfigFromFile, getDefaultConfigPath, getEnabledPairs } from "./config/loader.js";
import { CopyTradingOrchestrator } from "./core/orchestrator.js";
import { createHyperliquidClients } from "./clients/hyperliquid.js";
import { LeaderState } from "./domain/leaderState.js";
import { FollowerState } from "./domain/followerState.js";
import { MarketMetadataService } from "./services/marketMetadata.js";
import { SignalProcessor } from "./services/signalProcessor.js";
import { Reconciler } from "./services/reconciler.js";
import { SubscriptionService } from "./services/subscriptions.js";
import { logger, setLogLevel, getLogLevel } from "./utils/logger.js";

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
  
  // Set log level from configuration (can be overridden by LOG_LEVEL env var)
  setLogLevel(config.logLevel);
  logger.info("Log level configured", { logLevel: getLogLevel() });
  
  const enabledPairs = getEnabledPairs(config);

  if (enabledPairs.length === 0) {
    logger.error("No enabled pairs found in configuration");
    process.exit(1);
  }

  logger.info("Multi-pair mode initialized", {
    environment: config.environment,
    logLevel: config.logLevel,
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

  // Ensure metadata is loaded before creating signal processor
  await metadataService.ensureLoaded();

  // Signal processor for handling leader fills and executing copy trades
  const signalProcessor = new SignalProcessor({
    exchangeClient: clients.exchangeClient,
    infoClient: clients.infoClient,
    leaderAddress: config.leaderAddress as `0x${string}`,
    followerAddress: clients.followerTradingAddress,
    leaderState,
    followerState,
    metadataService,
    risk: config.risk,
    log: logger,
    // Trade logging configuration
    pairId: "legacy",
    logDir: "./data/state",
    enableTradeLog: true,
  });

  // Periodic reconciliation service to sync full account state from Hyperliquid API
  // NOTE: Only syncs state, does NOT trigger trades
  const reconciler = new Reconciler(
    clients.infoClient,
    config,
    leaderState,
    followerState,
    clients.followerTradingAddress,
    logger,
  );

  // WebSocket subscription service for real-time leader fill updates
  // Trading is driven by WebSocket fills via SignalProcessor
  const subscriptions = new SubscriptionService(
    clients.subscriptionClient,
    config,
    leaderState,
    signalProcessor,
    logger,
  );

  // Perform initial reconciliation to sync state
  await reconciler.reconcileOnce();

  // Start WebSocket subscriptions to leader fills
  // This is the single source of trading signals
  await subscriptions.start();

  // Start periodic reconciliation loop (state sync only, no trading)
  reconciler.start();

  logger.info("✅ Single-pair mode started successfully");
  logger.info("📡 Listening for leader trades via WebSocket...");

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
    // Get the directory of the current module (works with ES modules)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    
    // Try multiple paths for .env file (handles different deployment scenarios)
    const envPaths = [
      resolve(process.cwd(), ".env"),           // Current working directory
      resolve(__dirname, "..", ".env"),         // Project root (from dist/)
      resolve(__dirname, "..", "..", ".env"),   // One more level up
    ];
    
    let envLoaded = false;
    for (const envPath of envPaths) {
      if (existsSync(envPath)) {
        dotenv.config({ path: envPath });
        logger.info("Loaded environment variables", { path: envPath });
        envLoaded = true;
        break;
      }
    }
    
    if (!envLoaded) {
      logger.warn("No .env file found, using system environment variables only", {
        searchedPaths: envPaths,
      });
    }

    logger.info("Hyperliquid Copy Trading Agent starting", {
      version: "2.0.0",
      nodeVersion: process.version,
      cwd: process.cwd(),
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
