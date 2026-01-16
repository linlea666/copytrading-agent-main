/**
 * 交易日志记录器
 *
 * 按领航员地址分目录，按日期分文件存储交易日志。
 * 日志格式设计为一目了然，方便非技术人员查看。
 *
 * 目录结构：
 * logs/trades/{领航员地址}/{日期}.jsonl
 *
 * 使用 JSONL 格式（每行一条 JSON），便于追加写入和查询。
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TradingSignal, CopyAction } from "../domain/types.js";
import { logger, type Logger } from "./logger.js";

/**
 * 交易日志条目 - 设计为易读格式
 */
export interface TradeLogEntry {
  /** 记录时间 */
  时间: string;
  /** 日志类型 */
  类型: "收到信号" | "执行交易" | "跳过交易" | "错误";
  /** 跟单对ID */
  跟单对: string;

  /** 领航员信息 */
  领航员: {
    地址: string;
    资产: string;
  };

  /** 跟单者信息 */
  跟单者: {
    地址: string;
    资产: string;
  };

  /** 信号详情（领航员的操作） */
  信号?: {
    币种: string;
    操作: string;
    数量: string;
    价格: string;
    金额: string;
    订单号: number;
    是否新开仓: string;
    是否完全平仓: string;
  };

  /** 执行结果（跟单者的操作） */
  执行?: {
    动作: string;
    数量: string;
    金额: string;
    状态: "成功" | "失败" | "跳过";
    原因?: string;
  };

  /** 错误信息 */
  错误?: {
    描述: string;
    详情?: string;
  };
}

/**
 * 交易日志记录器配置
 */
export interface TradeLoggerConfig {
  /** 日志存储根目录 */
  logDir: string;
  /** 跟单对ID */
  pairId: string;
  /** 领航员地址 */
  leaderAddress: string;
  /** 跟单者地址 */
  followerAddress: string;
  /** 是否启用日志 */
  enabled?: boolean;
}

/**
 * 格式化地址显示（截短）
 */
function formatAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * 格式化数字为易读字符串
 */
function formatNumber(value: number, decimals: number = 4): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

/**
 * 格式化金额（带美元符号）
 */
function formatUsd(value: number): string {
  return "$" + formatNumber(value, 2);
}

/**
 * 获取当前日期字符串（用于文件名）
 */
function getDateString(): string {
  const dateStr = new Date().toISOString().split("T")[0];
  return dateStr ?? new Date().toISOString().slice(0, 10); // "2026-01-16"
}

/**
 * 获取当前时间字符串（易读格式）
 */
function getTimeString(): string {
  return new Date().toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * 翻译交易方向为中文
 */
function translateDirection(dir: string): string {
  const map: Record<string, string> = {
    "Open Long": "开多仓",
    "Close Long": "平多仓",
    "Open Short": "开空仓",
    "Close Short": "平空仓",
    "Long > Short": "反向：多转空",
    "Short > Long": "反向：空转多",
  };
  return map[dir] || dir;
}

/**
 * 交易日志记录器
 */
export class TradeLogger {
  private readonly logDir: string;
  private readonly leaderDir: string;
  private readonly enabled: boolean;
  private readonly log: Logger;

  private leaderEquity: number = 0;
  private followerEquity: number = 0;

  constructor(
    private readonly config: TradeLoggerConfig,
    log: Logger = logger,
  ) {
    this.log = log;
    this.enabled = config.enabled ?? true;

    // 设置日志目录：logs/trades/{领航员地址}/
    this.logDir = config.logDir;
    this.leaderDir = join(this.logDir, "trades", config.leaderAddress.toLowerCase());

    // 确保目录存在
    if (this.enabled) {
      this.ensureDirectoryExists();
    }
  }

  /**
   * 更新账户资产信息（用于日志记录）
   */
  updateEquity(leaderEquity: number, followerEquity: number): void {
    this.leaderEquity = leaderEquity;
    this.followerEquity = followerEquity;
  }

  /**
   * 记录收到领航员信号
   */
  logSignal(signal: TradingSignal): void {
    if (!this.enabled) return;

    const entry: TradeLogEntry = {
      时间: getTimeString(),
      类型: "收到信号",
      跟单对: this.config.pairId,
      领航员: {
        地址: formatAddress(this.config.leaderAddress),
        资产: formatUsd(this.leaderEquity),
      },
      跟单者: {
        地址: formatAddress(this.config.followerAddress),
        资产: formatUsd(this.followerEquity),
      },
      信号: {
        币种: signal.coin,
        操作: translateDirection(signal.direction),
        数量: formatNumber(signal.size, 6),
        价格: formatUsd(signal.price),
        金额: formatUsd(signal.size * signal.price),
        订单号: signal.orderId,
        是否新开仓: signal.isNewPosition ? "是" : "否",
        是否完全平仓: signal.isFullClose ? "是" : "否",
      },
    };

    this.writeLog(entry);
  }

  /**
   * 记录执行交易成功
   */
  logTradeSuccess(action: CopyAction, orderId?: string): void {
    if (!this.enabled) return;

    const entry: TradeLogEntry = {
      时间: getTimeString(),
      类型: "执行交易",
      跟单对: this.config.pairId,
      领航员: {
        地址: formatAddress(this.config.leaderAddress),
        资产: formatUsd(this.leaderEquity),
      },
      跟单者: {
        地址: formatAddress(this.config.followerAddress),
        资产: formatUsd(this.followerEquity),
      },
      执行: {
        动作: action.description,
        数量: formatNumber(action.size, 6) + " " + action.coin,
        金额: formatUsd(action.size * action.price),
        状态: "成功",
      },
    };

    this.writeLog(entry);
  }

  /**
   * 记录执行交易失败
   */
  logTradeFailed(action: CopyAction, reason: string): void {
    if (!this.enabled) return;

    const entry: TradeLogEntry = {
      时间: getTimeString(),
      类型: "执行交易",
      跟单对: this.config.pairId,
      领航员: {
        地址: formatAddress(this.config.leaderAddress),
        资产: formatUsd(this.leaderEquity),
      },
      跟单者: {
        地址: formatAddress(this.config.followerAddress),
        资产: formatUsd(this.followerEquity),
      },
      执行: {
        动作: action.description,
        数量: formatNumber(action.size, 6) + " " + action.coin,
        金额: formatUsd(action.size * action.price),
        状态: "失败",
        原因: reason,
      },
    };

    this.writeLog(entry);
  }

  /**
   * 记录跳过交易
   */
  logTradeSkipped(coin: string, reason: string, details?: Record<string, unknown>): void {
    if (!this.enabled) return;

    const entry: TradeLogEntry = {
      时间: getTimeString(),
      类型: "跳过交易",
      跟单对: this.config.pairId,
      领航员: {
        地址: formatAddress(this.config.leaderAddress),
        资产: formatUsd(this.leaderEquity),
      },
      跟单者: {
        地址: formatAddress(this.config.followerAddress),
        资产: formatUsd(this.followerEquity),
      },
      执行: {
        动作: `跳过 ${coin}`,
        数量: "-",
        金额: "-",
        状态: "跳过",
        原因: reason,
      },
    };

    this.writeLog(entry);
  }

  /**
   * 记录错误
   */
  logError(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (!this.enabled) return;

    const entry: TradeLogEntry = {
      时间: getTimeString(),
      类型: "错误",
      跟单对: this.config.pairId,
      领航员: {
        地址: formatAddress(this.config.leaderAddress),
        资产: formatUsd(this.leaderEquity),
      },
      跟单者: {
        地址: formatAddress(this.config.followerAddress),
        资产: formatUsd(this.followerEquity),
      },
      错误: {
        描述: message,
        ...(error?.message ? { 详情: error.message } : {}),
      },
    };

    this.writeLog(entry);
  }

  /**
   * 写入日志到文件
   */
  private writeLog(entry: TradeLogEntry): void {
    try {
      const filename = `${getDateString()}.jsonl`;
      const filepath = join(this.leaderDir, filename);

      // 确保目录存在
      this.ensureDirectoryExists();

      // 追加写入（每行一条 JSON）
      const line = JSON.stringify(entry, null, 0) + "\n";
      appendFileSync(filepath, line, "utf-8");
    } catch (error) {
      // 日志写入失败不应影响主流程
      this.log.warn("Failed to write trade log", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 确保日志目录存在
   */
  private ensureDirectoryExists(): void {
    if (!existsSync(this.leaderDir)) {
      mkdirSync(this.leaderDir, { recursive: true });
    }
  }
}
