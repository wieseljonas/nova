/**
 * Shell utility functions
 */

/**
 * Quote a string value for safe use in shell commands.
 * Wraps the value in single quotes and escapes embedded single quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
