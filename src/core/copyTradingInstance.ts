/**
 * Single copy trading instance for one leader-follower pair.
 *
 * Encapsulates all components needed for copy trading:
 * - State management (leader & follower)
 * - Historical position tracking
 * - WebSocket subscriptions
 * - Signal processing and trade execution
 * - Periodic state reconciliation
 *
 * Trading Flow (simplified):
 * 1. WebSocket receives leader's fill events
 * 2. SignalProcessor processes fills and executes copy trades
 * 3. Reconciler periodically syncs state (no trading)
 */

import type * as hl from "@nktkas/hyperliquid";
import type { CopyPairConfig, MultiCopyTradingConfig } from "../config/types.js";
import { LeaderState } from "../domain/leaderState.js";
import { FollowerState } from "../domain/followerState.js";
import { HistoryPositionTracker } from "../domain/historyTracker.js";
import { MarketMetadataService } from "../services/marketMetadata.js";
import { SignalProcessor } from "../services/signalProcessor.js";
import { SubscriptionService } from "../services/subscriptions.js";
import { Reconciler } from "../services/reconciler.js";
import { createInstanceLogger } from "../utils/instanceLogger.js";
import { logger, type Logger } from "../utils/logger.js";

/**
 * Hyperliquid clients bundle for a single pair.
 */
export interface PairClients {
  infoClient: hl.InfoClient;
  exchangeClient: hl.ExchangeClient;
  subscriptionClient: hl.SubscriptionClient;
  followerTradingAddress: `0x${string}`;
}

/**
 * Status of a copy trading instance.
 */
export type InstanceStatus = "created" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * Single copy trading instance for one leader-follower pair.
 */
export class CopyTradingInstance {
  private readonly leaderState: LeaderState;
  private readonly followerState: FollowerState;
  private readonly historyTracker: HistoryPositionTracker;
  private readonly signalProcessor: SignalProcessor;
  private readonly subscriptions: SubscriptionService;
  private readonly reconciler: Reconciler;
  private readonly log: Logger;

  private status: InstanceStatus = "created";

  /**
   * Creates a new copy trading instance.
   *
   * @param pairConfig - Configuration for this leader-follower pair
   * @param globalConfig - Global configuration (intervals, etc.)
   * @param sharedMetadata - Shared market metadata service
   * @param clients - Hyperliquid API clients for this pair
   */
  constructor(
    private readonly pairConfig: CopyPairConfig,
    private readonly globalConfig: MultiCopyTradingConfig,
    private readonly sharedMetadata: MarketMetadataService,
    private readonly clients: PairClients,
  ) {
    // Create instance-specific logger
    this.log = createInstanceLogger(pairConfig.id, logger);

    // Initialize state stores
    this.leaderState = new LeaderState();
    this.followerState = new FollowerState();

    // Initialize historical position tracker with persistence
    this.historyTracker = new HistoryPositionTracker(
      pairConfig.id,
      pairConfig.leaderAddress,
      globalConfig.stateDir,
      this.log,
    );

    // Initialize signal processor (core trading logic)
    this.signalProcessor = new SignalProcessor({
      exchangeClient: clients.exchangeClient,
      infoClient: clients.infoClient,
      leaderAddress: pairConfig.leaderAddress as `0x${string}`,
      followerAddress: clients.followerTradingAddress,
      leaderState: this.leaderState,
      followerState: this.followerState,
      metadataService: this.sharedMetadata,
      risk: pairConfig.risk,
      minOrderNotionalUsd: pairConfig.minOrderNotionalUsd,
      historyTracker: this.historyTracker,
      syncLeverage: true,
      log: this.log,
      // Trade logging configuration
      pairId: pairConfig.id,
      logDir: globalConfig.stateDir,
      enableTradeLog: globalConfig.enableTradeLog ?? true,
      // Position aggregation mode
      enablePositionAggregation: pairConfig.enablePositionAggregation ?? false,
    });

    // Initialize WebSocket subscription service
    const subscriptionConfig = {
      leaderAddress: pairConfig.leaderAddress,
      websocketAggregateFills: globalConfig.websocketAggregateFills,
    };
    this.subscriptions = new SubscriptionService(
      clients.subscriptionClient,
      subscriptionConfig as any,
      this.leaderState,
      this.signalProcessor,
      this.log,
    );

    // Initialize reconciler (state sync + fallback full close)
    const reconcilerConfig = {
      leaderAddress: pairConfig.leaderAddress,
      reconciliationIntervalMs: globalConfig.reconciliationIntervalMs,
    };
    this.reconciler = new Reconciler(
      clients.infoClient,
      reconcilerConfig as any,
      this.leaderState,
      this.followerState,
      clients.followerTradingAddress,
      this.log,
    );

    // Enable fallback full close feature
    this.reconciler.setFallbackDeps({
      exchangeClient: clients.exchangeClient,
      metadataService: sharedMetadata,
      historyTracker: this.historyTracker,
      ...(pairConfig.risk.marketOrderSlippage !== undefined && {
        marketOrderSlippage: pairConfig.risk.marketOrderSlippage,
      }),
    });

    // Enable position aggregation mode if configured
    // 聚合模式：加仓通过对账同步，减仓通过实时信号或兜底全平
    if (pairConfig.enablePositionAggregation) {
      this.reconciler.enableAggregationMode({
        enabled: true,
        copyRatio: pairConfig.risk.copyRatio,
        minOrderNotionalUsd: pairConfig.minOrderNotionalUsd,
      });
    }
  }

  /**
   * Gets the pair ID.
   */
  get id(): string {
    return this.pairConfig.id;
  }

  /**
   * Gets the current status.
   */
  getStatus(): InstanceStatus {
    return this.status;
  }

  /**
   * Gets the leader address.
   */
  getLeaderAddress(): string {
    return this.pairConfig.leaderAddress;
  }

  /**
   * Gets the follower trading address.
   */
  getFollowerAddress(): string {
    return this.clients.followerTradingAddress;
  }

  /**
   * Starts the copy trading instance.
   *
   * Startup sequence:
   * 1. Ensure market metadata is loaded
   * 2. Perform initial reconciliation to get current state
   * 3. Initialize historical position tracker
   * 4. Start WebSocket subscriptions (this triggers copy trading)
   * 5. Start periodic state reconciliation (no trading)
   */
  async start(): Promise<void> {
    if (this.status === "running") {
      this.log.warn("Instance already running");
      return;
    }

    this.status = "starting";
    this.log.info("Starting copy trading instance", {
      leader: this.pairConfig.leaderAddress,
      follower: this.clients.followerTradingAddress,
      copyRatio: this.pairConfig.risk.copyRatio,
      minOrderNotionalUsd: this.pairConfig.minOrderNotionalUsd,
    });

    try {
      // 1. Ensure market metadata is loaded
      await this.sharedMetadata.ensureLoaded();

      // 2. Perform initial reconciliation to get current state
      await this.reconciler.reconcileOnce();

      // Log account status after initial reconciliation
      const leaderMetrics = this.leaderState.getMetrics();
      const followerMetrics = this.followerState.getMetrics();
      this.log.info("Account status after initial sync", {
        leader: {
          address: this.pairConfig.leaderAddress,
          equity: "$" + leaderMetrics.accountValueUsd.toFixed(2),
          positions: this.leaderState.getPositions().size,
        },
        follower: {
          address: this.clients.followerTradingAddress,
          equity: "$" + followerMetrics.accountValueUsd.toFixed(2),
          positions: this.followerState.getPositions().size,
        },
      });

      // Warn if follower has no balance
      if (followerMetrics.accountValueUsd <= 0) {
        this.log.error("CRITICAL: Follower account has ZERO balance! Cannot execute any trades.", {
          followerAddress: this.clients.followerTradingAddress,
          hint: "Please deposit USDC to this address on Hyperliquid",
        });
      }

      // 3. Initialize historical position tracker
      const historicalCoins = this.historyTracker.initialize(this.leaderState.getPositions());

      if (historicalCoins.length > 0) {
        this.log.info("Historical positions detected (will not copy)", {
          coins: historicalCoins,
          count: historicalCoins.length,
        });
      } else {
        this.log.info("No historical positions - all new leader trades will be copied");
      }

      // 4. Start WebSocket subscriptions
      // This is where copy trading happens - fills trigger SignalProcessor
      await this.subscriptions.start();

      // 5. Start periodic state reconciliation (no trading, just state sync)
      this.reconciler.start();

      this.status = "running";
      this.log.info("✅ Copy trading instance started successfully");
      this.log.info("📡 Listening for leader trades via WebSocket...");
    } catch (error) {
      this.status = "error";
      this.log.error("Failed to start copy trading instance", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stops the copy trading instance.
   */
  async stop(): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") {
      return;
    }

    this.status = "stopping";
    this.log.info("Stopping copy trading instance");

    try {
      // Stop WebSocket subscriptions
      await this.subscriptions.stop().catch((error) => {
        this.log.error("Error stopping subscriptions", { error });
      });

      // Stop periodic reconciliation
      this.reconciler.stop();

      // Save historical position state
      this.historyTracker.stop();

      this.status = "stopped";
      this.log.info("Copy trading instance stopped");
    } catch (error) {
      this.log.error("Error during shutdown", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.status = "error";
    }
  }

  /**
   * Gets current leader positions.
   */
  getLeaderPositions() {
    return this.leaderState.getPositions();
  }

  /**
   * Gets current follower positions.
   */
  getFollowerPositions() {
    return this.followerState.getPositions();
  }

  /**
   * Gets historical positions.
   */
  getHistoricalCoins(): string[] {
    return this.historyTracker.getHistoricalCoins();
  }

  /**
   * Manually triggers a state reconciliation.
   * NOTE: This only syncs state, it does NOT trigger trades.
   */
  async refreshState(): Promise<void> {
    await this.reconciler.reconcileOnce();
  }
}
