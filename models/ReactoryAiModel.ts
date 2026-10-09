import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import ReactoryAiProvider from './ReactoryAiProvider';

export interface ModelSamplingSupportJson {
  temperature?: boolean;
  topP?: boolean;
  topK?: boolean;
}

export interface ModelThinkingSupportJson {
  mode?: 'adaptive' | 'budget' | 'none';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  display?: 'summarized' | 'omitted';
}

@Entity({ name: 'reactory_ai_models' })
@Index(['providerId', 'modelKey'], { unique: true })
export default class ReactoryAiModel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  modelKey: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  providerId: string;

  @ManyToOne(() => ReactoryAiProvider, (provider) => provider.models, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'providerId' })
  provider: ReactoryAiProvider;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  version?: string;

  @Column({ type: 'integer', nullable: true })
  contextLength?: number;

  @Column({ type: 'integer', nullable: true })
  maxOutputTokens?: number;

  @Column('text', { array: true, default: '{}' })
  capabilities: string[];

  @Column({ type: 'boolean', default: true })
  supportsStreaming: boolean;

  @Column('text', { array: true, default: '{function-calling}' })
  supportedTools: string[];

  @Column('text', { array: true, default: '{text}' })
  supportedMediaTypes: string[];

  @Column({ type: 'numeric', precision: 12, scale: 8, nullable: true })
  inputCostPerTokenUsdCents?: number;

  @Column({ type: 'numeric', precision: 12, scale: 8, nullable: true })
  outputCostPerTokenUsdCents?: number;

  /**
   * Prompt-cache rates, cents/token. Optional: a model whose rates are absent
   * prices every prompt token at the plain input rate (the cache-miss rate),
   * which is the honest upper bound rather than an understated discount.
   */
  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  cacheHitCostPerTokenUsdCents?: number;

  @Column({ type: 'numeric', precision: 18, scale: 10, nullable: true })
  cacheMissCostPerTokenUsdCents?: number;

  @Column({ type: 'numeric', precision: 12, scale: 8, nullable: true })
  costPerToken?: number;

  @Column({ type: 'integer', nullable: true })
  rpm?: number;

  @Column({ type: 'integer', nullable: true })
  itpm?: number;

  @Column({ type: 'integer', nullable: true })
  otpm?: number;

  @Column({ type: 'integer', nullable: true })
  maxParallelRequests?: number;

  @Column({ type: 'jsonb', nullable: true })
  samplingConfig?: ModelSamplingSupportJson;

  @Column({ type: 'jsonb', nullable: true })
  thinkingConfig?: ModelThinkingSupportJson;

  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ type: 'integer', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
