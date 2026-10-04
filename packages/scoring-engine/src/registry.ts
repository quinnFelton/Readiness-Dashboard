/**
 * Strategy registries for running several variants side by side (PLAN §8.7 classifiers,
 * §8.8 activity-effort derivers). Variants are identified by a stable `id` that is persisted
 * with their output (`trends.classifier_id`, `activity_efforts.deriver_id`), so ids must never
 * be reused for a different method. A bug fix to one variant bumps DERIVATION_VERSION instead.
 */

const ID_RE = /^[a-z][a-z0-9_]{0,62}$/;

export interface Strategy {
  /** Stable, persisted id, e.g. "peak20_v1". Lowercase snake_case. */
  readonly id: string;
  /** One line for the `derivers` / `classifiers` table and admin UI. */
  readonly description: string;
}

export class StrategyRegistry<T extends Strategy> {
  private readonly byId = new Map<string, T>();

  constructor(
    private readonly kind: string,
    initial: readonly T[] = [],
  ) {
    for (const s of initial) this.register(s);
  }

  register(s: T): this {
    if (!ID_RE.test(s.id)) throw new Error(`${this.kind} id "${s.id}" must match ${ID_RE}`);
    if (this.byId.has(s.id)) throw new Error(`${this.kind} "${s.id}" is already registered`);
    this.byId.set(s.id, s);
    return this;
  }

  get(id: string): T | undefined {
    return this.byId.get(id);
  }

  /** Throws for an unknown id: a default that isn't registered is a deploy error, not a skip. */
  require(id: string): T {
    const s = this.byId.get(id);
    if (!s) throw new Error(`unknown ${this.kind} "${id}"`);
    return s;
  }

  /** Registration order, so output is deterministic. */
  list(): T[] {
    return [...this.byId.values()];
  }
}
