/**
 * Counts failed sign-ins per username in memory: after `limit` failures inside the window the username is
 * blocked until the oldest of them is older than the window. A restart clears the counters.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly now: () => Date,
    private readonly limit = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(username: string): boolean {
    return this.recent(username).length >= this.limit;
  }

  recordFailure(username: string): void {
    this.failures.set(username, [...this.recent(username), this.now().getTime()]);
  }

  reset(username: string): void {
    this.failures.delete(username);
  }

  /** Failures still inside the window; forgets the username when none are left. */
  private recent(username: string): number[] {
    const since = this.now().getTime() - this.windowMs;
    const kept = (this.failures.get(username) ?? []).filter((at) => at > since);
    if (kept.length === 0) this.failures.delete(username);
    return kept;
  }
}
