/**
 * Multi-pair copy trading orchestrator.
 *
 * Manages multiple CopyTradingInstance objects, each handling
 * one leader-follower pair independently.
 *
 * Features:
 * - Shared market metadata service across all instances
 * - Independent instance lifecycle management
 * - Graceful shutdown handling
 * - Status monitoring for all instances
 */

import * as hl from "@nktkas/hyperliquid";
import WebSocket from "ws";
import { privateKeyToAccount } from "viem/accounts";
import type { CopyPairConfig, MultiCopyTradingConfig, HyperliquidEnvironment } from "../config/types.js";
import { MarketMetadataService } from "../services/marketMetadata.js";
import { CopyTradingInstance, type PairClients, type InstanceStatus } from "./copyTradingInstance.js";
import { logger, type Logger } from "../utils/logger.js";

/**
 * Status summary for all instances.
 */
export interface OrchestratorStatus {
  totalPairs: number;
  enabledPairs: number;
  runningInstances: number;
  instances: Array<{
    id: string;
    status: InstanceStatus;
    leader: string;
    follower: string;
  }>;
}

/**
 * Creates Hyperliquid clients for a single pair.
 */
function createPairClients(
  pairConfig: CopyPairConfig,
  environment: HyperliquidEnvironment,
  sharedWsTransport: hl.WebSocketTransport,
  sharedHttpTransport: hl.HttpTransport,
): PairClients {
  // Create viem account from private key
  const followerAccount = privateKeyToAccount(pairConfig.followerPrivateKey);

  // Determine trading address (vault or wallet)
  const followerTradingAddress = (pairConfig.followerVaultAddress ??
    followerAccount.address) as `0x${string}`;

  // Create Info client (read-only, shares HTTP transport)
  const infoClient = new hl.InfoClient({ transport: sharedHttpTransport });

  // Create Exchange client for this pair
  const exchangeClient = new hl.ExchangeClient({
    transport: sharedHttpTransport,
    wallet: followerAccount,
    ...(pairConfig.followerVaultAddress ? { defaultVaultAddress: pairConfig.followerVaultAddress } : {}),
    signatureChainId: async () => {
      return environment === "testnet" ? ("0x66eee" as const) : ("0x1" as const);
    },
  });

  // Create Subscription client (shares WebSocket transport)
  const subscriptionClient = new hl.SubscriptionClient({ transport: sharedWsTransport });

  return {
    infoClient,
    exchangeClient,
    subscriptionClient,
    followerTradingAddress,
  };
}

/**
 * Node.js WebSocket adapter for the Hyperliquid SDK.
 */
class NodeWebSocketWrapper extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const address = typeof url === "string" ? url : url.toString();
    super(address, protocols);
    this.binaryType = "arraybuffer";
  }

  dispatchEvent(event: Event): boolean {
    const handlerKey = `on${event.type}` as const;
    const handler = (this as unknown as Record<string, ((event: Event) => void) | null>)[handlerKey];
    if (typeof handler === "function") {
      handler.call(this, event);
    }
    return super.emit(event.type, event);
  }
}

/**
 * Orchestrates multiple copy trading instances.
 */
export class CopyTradingOrchestrator {
  private readonly instances = new Map<string, CopyTradingInstance>();
  private readonly sharedMetadata: MarketMetadataService;
  private readonly sharedHttpTransport: hl.HttpTransport;
  private readonly sharedWsTransport: hl.WebSocketTransport;
  private readonly log: Logger;
  private shuttingDown = false;

  /**
   * Creates a new orchestrator.
   *
   * @param config - Multi-pair configuration
   */
  constructor(private readonly config: MultiCopyTradingConfig) {
    this.log = logger;

    // Create shared HTTP transport
    this.sharedHttpTransport = new hl.HttpTransport({
      isTestnet: config.environment === "testnet",
      timeout: 10_000,
    });

    // Create shared WebSocket transport
    this.sharedWsTransport = new hl.WebSocketTransport({
      isTestnet: config.environment === "testnet",
      reconnect: {
        WebSocket: NodeWebSocketWrapper as unknown as typeof globalThis.WebSocket,
        maxRetries: Number.POSITIVE_INFINITY,
      },
    });

    // Create shared market metadata service
    const sharedInfoClient = new hl.InfoClient({ transport: this.sharedHttpTransport });
    this.sharedMetadata = new MarketMetadataService(sharedInfoClient, this.log);

    // Log WebSocket connection status
    this.sharedWsTransport.ready().catch((error) => {
      this.log.error("WebSocket transport failed to initialize", { error });
    });
  }

  /**
   * Starts all enabled copy trading instances.
   */
  async start(): Promise<void> {
    const enabledPairs = this.config.pairs.filter((p) => p.enabled);

    this.log.info("Starting copy trading orchestrator", {
      environment: this.config.environment,
      totalPairs: this.config.pairs.length,
      enabledPairs: enabledPairs.length,
      stateDir: this.config.stateDir,
    });

    if (enabledPairs.length === 0) {
      this.log.warn("No enabled pairs found in configuration");
      return;
    }

    // Pre-load market metadata
    await this.sharedMetadata.ensureLoaded();

    // Start each enabled pair
    for (const pairConfig of enabledPairs) {
      try {
        await this.startInstance(pairConfig);
      } catch (error) {
        this.log.error(`Failed to start instance ${pairConfig.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other pairs
      }
    }

    const runningCount = Array.from(this.instances.values()).filter(
      (i) => i.getStatus() === "running",
    ).length;

    this.log.info("Orchestrator startup complete", {
      runningInstances: runningCount,
      totalEnabled: enabledPairs.length,
    });
  }

  /**
   * Starts a single instance.
   */
  private async startInstance(pairConfig: CopyPairConfig): Promise<void> {
    if (this.instances.has(pairConfig.id)) {
      this.log.warn(`Instance ${pairConfig.id} already exists`);
      return;
    }

    this.log.info(`Creating instance: ${pairConfig.id}`);

    // Create clients for this pair
    const clients = createPairClients(
      pairConfig,
      this.config.environment,
      this.sharedWsTransport,
      this.sharedHttpTransport,
    );

    // Create instance
    const instance = new CopyTradingInstance(
      pairConfig,
      this.config,
      this.sharedMetadata,
      clients,
    );

    this.instances.set(pairConfig.id, instance);

    // Start instance
    await instance.start();
  }

  /**
   * Stops all instances and cleans up resources.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    this.log.info("Stopping copy trading orchestrator", {
      instances: this.instances.size,
    });

    // Stop all instances in parallel
    const stopPromises = Array.from(this.instances.values()).map(async (instance) => {
      try {
        await instance.stop();
      } catch (error) {
        this.log.error(`Error stopping instance ${instance.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    await Promise.all(stopPromises);

    // Close shared WebSocket transport
    try {
      await this.sharedWsTransport.close();
    } catch {
      // Ignore close errors
    }

    this.instances.clear();
    this.log.info("Orchestrator stopped");
  }

  /**
   * Gets status of all instances.
   */
  getStatus(): OrchestratorStatus {
    const instances = Array.from(this.instances.values()).map((instance) => ({
      id: instance.id,
      status: instance.getStatus(),
      leader: instance.getLeaderAddress(),
      follower: instance.getFollowerAddress(),
    }));

    return {
      totalPairs: this.config.pairs.length,
      enabledPairs: this.config.pairs.filter((p) => p.enabled).length,
      runningInstances: instances.filter((i) => i.status === "running").length,
      instances,
    };
  }

  /**
   * Gets a specific instance by ID.
   */
  getInstance(id: string): CopyTradingInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Gets all instances.
   */
  getAllInstances(): CopyTradingInstance[] {
    return Array.from(this.instances.values());
  }
}
