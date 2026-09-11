import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import ReactoryAiModel from './ReactoryAiModel';

export interface ProviderRateLimitsJson {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrentRequests?: number;
}

export interface ProviderStatusJson {
  available: boolean;
  lastChecked?: Date | string;
  uptime?: number;
  responseTime?: number;
  errorRate?: number;
  quotaRemaining?: number;
}

@Entity({ name: 'reactory_ai_providers' })
export default class ReactoryAiProvider {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 50, default: 'custom' })
  providerType: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  endpointUrl?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  apiVersion?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  authComponentFqn?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  defaultModelId?: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  credentialRequirements: string[];

  @Column({ type: 'jsonb', default: () => "'{}'" })
  credentialEnvVars: Record<string, string>;

  @Column('text', { array: true, default: '{}' })
  capabilities: string[];

  @Column('text', { array: true, default: '{USER}' })
  roles: string[];

  @Column({ type: 'jsonb', nullable: true })
  rateLimits?: ProviderRateLimitsJson;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  status: ProviderStatusJson;

  @Column({ type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  organizationId?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  createdBy?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;

  @OneToMany(() => ReactoryAiModel, (model) => model.provider, {
    cascade: true,
  })
  models: ReactoryAiModel[];
}
