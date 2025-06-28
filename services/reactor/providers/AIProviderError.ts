import ApiError from '../../../../../exceptions';

export class AIProviderError extends ApiError {
  public code: string;
  
  constructor(message: string, meta = {}) {
    super(message, meta);
    this.code = 'AI-PROVIDER-500';
  }
}
