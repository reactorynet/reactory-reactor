import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * An append-only price-list entry for a provider model.
 *
 * WHY THIS IS A SEPARATE, APPEND-ONLY TABLE
 *
 * `reactory_ai_models` holds the *current* rates as an admin-editable mirror, so
 * a price change overwrites the previous value and the prior price leaves no
 * trace. That made two things impossible:
 *
 *  1. **Auditing a change.** "DeepSeek raised their Flash input price on the
 *     14th" cannot be answered — the old rate is simply gone.
 *  2. **Explaining a historical cost.** A frozen `cost_usd_cents` on a turn is
 *     only defensible if the rates that produced it are still recoverable.
 *
 * Here, a price change *appends* a row. The current price is the row with the
 * greatest `effectiveFrom` (ties broken by `createdAt`) for a
 * `(providerId, modelKey)`; every earlier row remains as the history. A turn
 * stores the `pricing_id` it was priced with, so its cost can always be
 * reconciled against the exact entry in force at the time.
 *
 * Cache-awareness is part of the shape, not bolted on: prompt tokens are billed
 * at two different rates depending on whether the provider served them from its
 * prompt cache. Storing only a single input rate is what made every cache-heavy
 * turn look ~10x more expensive than the provider's own bill — the miss rate was
 * being charged against tokens the provider billed at the (far cheaper) hit
 * rate.
 *
 * All rates are **USD cents per token**. `inputCostPerTokenUsdCents` is retained
 * as the plain input rate and is treated as the cache-*miss* rate when a
 * separate miss rate is not given, so older/simpler providers still price
 * correctly.
 */
@Entity({ name: 'reactory_ai_model_pricing' })
@Index(['providerId', 'modelKey', 'effectiveFrom'])
export default class ReactoryAiModelPricing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  modelKey: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  providerId: string;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  /**
   * Plain input rate, cents/token. Used as the cache-miss rate when
   * `cacheMissCostPerTokenUsdCents` is absent.
   */
  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  inputCostPerTokenUsdCents?: number | null;

  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  outputCostPerTokenUsdCents?: number | null;

  /** Prompt tokens served from the provider's cache (billed at a discount). */
  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  cacheHitCostPerTokenUsdCents?: number | null;

  /** Prompt tokens NOT served from cache — the full input rate. */
  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  cacheMissCostPerTokenUsdCents?: number | null;

  /**
   * When this price took effect. The current price is the latest row by this
   * column; it doubles as the "price changed at" marker.
   */
  @Column({ name: 'effective_from', type: 'timestamp with time zone', default: () => 'now()' })
  effectiveFrom: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
