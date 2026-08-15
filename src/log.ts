// Timestamped logging helpers so log lines can be correlated with incidents
// (and so a relay restart is visible in the log stream).
function now(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]): void {
  console.log(now(), ...args);
}

export function error(...args: unknown[]): void {
  console.error(now(), ...args);
}
