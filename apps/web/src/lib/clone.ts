/**
 * Deep copy for plain JSON data. Unlike the browser's structured clone it
 * also works on Vue reactive proxies.
 */
export function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
