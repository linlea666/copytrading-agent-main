/**
 * Debounced sync manager for handling rapid leader fill events.
 *
 * When a leader executes multiple fills rapidly (e.g., quantitative trading),
 * this manager batches them by waiting for a quiet period before syncing.
 *
 * Benefits:
 * - Reduces number of follower orders (fewer fees, less slippage)
 * - Syncs to final position state, not intermediate states
 * - Handles large order splits that produce multiple fills
 */

import { logger, type Logger } from "../utils/logger.js";

/**
 * Manages debounced synchronization of follower positions.
 */
export class DebouncedSyncManager {
  private timer: NodeJS.Timeout | null = null;
  private pendingCount = 0;
  private lastRequestTime = 0;

  /**
   * Creates a new debounced sync manager.
   *
   * @param syncFn - Async function to execute for syncing
   * @param debounceMs - Milliseconds to wait after last request before executing
   * @param log - Logger instance
   */
  constructor(
    private readonly syncFn: () => Promise<void>,
    private readonly debounceMs: number,
    private readonly log: Logger = logger,
  ) {}

  /**
   * Requests a sync operation (debounced).
   *
   * Multiple rapid calls will be batched - only one sync executes
   * after the last request plus debounceMs delay.
   */
  requestSync() {
    this.pendingCount++;
    this.lastRequestTime = Date.now();

    // Clear existing timer
    if (this.timer) {
      clearTimeout(this.timer);
    }

    // Schedule new timer
    this.timer = setTimeout(async () => {
      this.timer = null;
      const count = this.pendingCount;
      this.pendingCount = 0;

      if (count > 1) {
        this.log.debug(`Executing batched sync`, { batchedFills: count });
      }

      try {
        await this.syncFn();
      } catch (error) {
        this.log.error("Debounced sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.debounceMs);
  }

  /**
   * Executes sync immediately, bypassing debounce.
   *
   * Use for:
   * - Periodic reconciliation
   * - Manual sync requests
   * - Shutdown procedures
   */
  async syncNow(): Promise<void> {
    // Cancel any pending debounced sync
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const count = this.pendingCount;
    this.pendingCount = 0;

    if (count > 0) {
      this.log.debug(`Immediate sync with pending requests`, { pendingCount: count });
    }

    await this.syncFn();
  }

  /**
   * Gets the number of pending sync requests.
   */
  getPendingCount(): number {
    return this.pendingCount;
  }

  /**
   * Checks if there's a pending sync scheduled.
   */
  hasPendingSync(): boolean {
    return this.timer !== null;
  }

  /**
   * Gets milliseconds since last sync request.
   */
  getTimeSinceLastRequest(): number {
    if (this.lastRequestTime === 0) return Infinity;
    return Date.now() - this.lastRequestTime;
  }

  /**
   * Stops the manager, canceling any pending sync.
   *
   * Note: Does NOT execute the pending sync. Use syncNow() first if needed.
   */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingCount = 0;
  }
}
