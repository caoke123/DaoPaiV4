const CDP_DISCONNECT_COOLDOWN_MS = 60_000;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 300_000;

export interface ReconnectDecision {
  windowId: string;
  shouldReconnect: boolean;
  failureCount: number;
  cooldownUntil: number;
  cooldownRemainingMs: number;
  reason: 'ready' | 'cooldown' | 'unknown';
}

export interface FailureRecord {
  failureCount: number;
  cooldownUntil: number;
  cooldownMs: number;
}

export class ReconnectPolicy {
  private retryCooldowns: Map<string, number> = new Map();
  private failureCounts: Map<string, number> = new Map();

  recordDisconnect(windowId: string): void {
    this.retryCooldowns.set(windowId, Date.now() + CDP_DISCONNECT_COOLDOWN_MS);
    this.failureCounts.set(windowId, Math.max(this.failureCounts.get(windowId) || 0, 1));
  }

  recordFailure(windowId: string): FailureRecord {
    const prevFailures = this.failureCounts.get(windowId) ?? 0;
    const nextFailures = prevFailures + 1;
    this.failureCounts.set(windowId, nextFailures);
    const nextCooldown = Math.min(BASE_COOLDOWN_MS * Math.pow(2, nextFailures - 1), MAX_COOLDOWN_MS);
    this.retryCooldowns.set(windowId, Date.now() + nextCooldown);
    return {
      failureCount: nextFailures,
      cooldownUntil: this.retryCooldowns.get(windowId)!,
      cooldownMs: nextCooldown,
    };
  }

  recordSuccess(windowId: string): void {
    this.retryCooldowns.delete(windowId);
    this.failureCounts.delete(windowId);
  }

  canReconnect(windowId: string): boolean {
    const cooldownUntil = this.retryCooldowns.get(windowId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return false;
    }
    return true;
  }

  getDecision(windowId: string): ReconnectDecision {
    const cooldownUntil = this.retryCooldowns.get(windowId);
    const failureCount = this.failureCounts.get(windowId) ?? 0;
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return {
        windowId,
        shouldReconnect: false,
        failureCount,
        cooldownUntil,
        cooldownRemainingMs: cooldownUntil - Date.now(),
        reason: 'cooldown',
      };
    }
    return {
      windowId,
      shouldReconnect: true,
      failureCount,
      cooldownUntil: cooldownUntil ?? 0,
      cooldownRemainingMs: 0,
      reason: 'ready',
    };
  }

  getFailureCount(windowId: string): number {
    return this.failureCounts.get(windowId) ?? 0;
  }

  getCooldownUntil(windowId: string): number {
    return this.retryCooldowns.get(windowId) ?? 0;
  }

  clear(windowId: string): void {
    this.retryCooldowns.delete(windowId);
    this.failureCounts.delete(windowId);
  }

  clearAll(): void {
    this.retryCooldowns.clear();
    this.failureCounts.clear();
  }
}
