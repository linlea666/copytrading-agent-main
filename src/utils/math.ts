/**
 * Math utility functions for safe numeric operations.
 */

/** Minimum position size to consider non-zero */
export const EPSILON = 1e-9;

/**
 * Determines the number of decimal places in a number's string representation.
 *
 * @param value - Number to check
 * @returns Number of decimal places
 */
export function getDecimalPlaces(value: number): number {
  const str = value.toString();
  const decimalIndex = str.indexOf(".");
  if (decimalIndex === -1) return 0;
  return str.length - decimalIndex - 1;
}

/**
 * Rounds a price to match the precision of a reference price.
 *
 * @param price - Price to round
 * @param markPrice - Reference price for precision
 * @returns Formatted price string
 */
export function roundToMarkPricePrecision(price: number, markPrice: number): string {
  const decimals = getDecimalPlaces(markPrice);
  let result = price.toFixed(decimals);
  if (decimals > 0) {
    result = result.replace(/\.?0+$/, "");
  }
  return result || "0";
}

/**
 * Converts various types to a floating-point number, with safe fallbacks.
 *
 * @param value - Value to convert (string, number, bigint, or nullish)
 * @returns Parsed number, or 0 if nullish
 * @throws {Error} If string value cannot be parsed as a number
 */
export function toFloat(value: string | number | bigint | undefined | null): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to parse numeric value: ${value}`);
  }
  return parsed;
}

/**
 * Rounds a number to a specified number of decimal places.
 *
 * @param value - Number to round
 * @param decimals - Number of decimal places (default: 6)
 * @returns Rounded number
 */
export function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Clamps a number between a minimum and maximum value.
 *
 * @param value - Number to clamp
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Clamped number
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Safely divides two numbers, returning a fallback if denominator is near zero.
 *
 * @param numerator - Numerator
 * @param denominator - Denominator
 * @param fallback - Value to return if denominator is ~0 (default: 0)
 * @returns Division result or fallback
 */
export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (Math.abs(denominator) < Number.EPSILON) {
    return fallback;
  }
  return numerator / denominator;
}

/**
 * Formats a Unix timestamp (milliseconds) to a human-readable string.
 * 
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted time string like "16:35:37" or "16:35:37.123"
 */
export function formatTimestamp(timestamp: number, includeMs = false): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  
  if (includeMs) {
    const ms = date.getMilliseconds().toString().padStart(3, "0");
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Formats a Unix timestamp to ISO date-time string in local timezone.
 * 
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted string like "2026-01-15 16:35:37"
 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
