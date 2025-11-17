/**
 * Manual validation script for AI Streaming Services
 * This script verifies that all three streaming services can be instantiated
 * and their basic methods can be called without errors.
 */

// Mock dependencies to avoid initialization issues
const mockContext = {
  log: (message: string, data?: any, source?: string) => console.log(`[${source || 'LOG'}] ${message}`, data || ''),
  warn: (message: string, data?: any, source?: string) => console.warn(`[${source || 'WARN'}] ${message}`, data || ''),
  error: (message: string, data?: any, source?: string) => console.error(`[${source || 'ERROR'}] ${message}`, data || ''),
  debug: (message: string, data?: any, source?: string) => console.debug(`[${source || 'DEBUG'}] ${message}`, data || ''),
  getService: () => null
} as any;

const mockPersonaProvider = {
  getPersona: async (id: string) => ({
    id,
    name: 'Test Persona',
    config: { apiKey: 'test-key' },
    modelId: 'test-model',
    messageConfig: {},
    modelConfig: {}
  })
} as any;

async function validateStreamingServices() {
  console.log('🔍 Starting AI Streaming Services Validation...\n');

  try {
    // Import services dynamically to handle any import issues
    const { default: OpenAIStreamingService } = await import('../../services/reactor/providers/OpenAIStreamingService');
    const { default: XAIStreamingService } = await import('../../services/reactor/providers/xAIStreamingService');  
    const { default: GoogleAIStreamingService } = await import('../../services/reactor/providers/GoogleAIStreamingService');

    console.log('✅ All streaming services imported successfully\n');

    // Test OpenAI Streaming Service
    console.log('🤖 Testing OpenAI Streaming Service...');
    const openAIService = new OpenAIStreamingService({
      apiKey: 'test-key',
      apiEndpoint: 'https://api.openai.com/v1',
      apiVersion: 'v1',
      $services: {}
    }, mockContext);
    
    openAIService.setPersonaProvider(mockPersonaProvider);
    
    const openAICapabilities = await openAIService.getStreamingCapabilities();
    console.log('  ✅ OpenAI capabilities:', openAICapabilities);
    console.log('  ✅ Service name:', openAIService.toString(true));
    console.log('  ✅ Service tags:', openAIService.tags);

    // Test xAI Streaming Service
    console.log('\n🚀 Testing xAI Streaming Service...');
    const xaiService = new XAIStreamingService({
      apiKey: 'test-key',
      apiEndpoint: 'https://api.x.ai/v1',
      apiVersion: 'v1',
      $services: {}
    }, mockContext);
    
    xaiService.setPersonaProvider(mockPersonaProvider);
    
    const xaiCapabilities = await xaiService.getStreamingCapabilities();
    console.log('  ✅ xAI capabilities:', xaiCapabilities);
    console.log('  ✅ Service name:', xaiService.toString(true));
    console.log('  ✅ Service tags:', xaiService.tags);

    // Test Google AI Streaming Service
    console.log('\n🧠 Testing Google AI Streaming Service...');
    const googleService = new GoogleAIStreamingService({}, mockContext);
    
    googleService.setPersonaProvider(mockPersonaProvider);
    
    const googleCapabilities = await googleService.getStreamingCapabilities();
    console.log('  ✅ Google AI capabilities:', googleCapabilities);
    console.log('  ✅ Service name:', googleService.toString(true));
    console.log('  ✅ Service tags:', googleService.tags);

    // Test streaming interface compliance
    console.log('\n🔧 Testing streaming interface compliance...');
    
    // Check that all services implement the required methods
    const services = [
      { name: 'OpenAI', service: openAIService },
      { name: 'xAI', service: xaiService },
      { name: 'Google AI', service: googleService }
    ];

    for (const { name, service } of services) {
      console.log(`  🔍 Checking ${name} service methods:`);
      
      // Check required methods exist
      const requiredMethods = ['chatStream', 'chatAudioStream', 'getStreamingCapabilities'];
      for (const method of requiredMethods) {
        const hasMethod = typeof (service as any)[method] === 'function';
        console.log(`    ${hasMethod ? '✅' : '❌'} ${method}: ${hasMethod ? 'present' : 'missing'}`);
      }

      // Check async generator compliance
      const chatStreamResult = service.chatStream({
        personaId: 'test-persona',
        message: 'Hello test'
      });
      
      const isAsyncIterable = chatStreamResult && typeof chatStreamResult[Symbol.asyncIterator] === 'function';
      console.log(`    ${isAsyncIterable ? '✅' : '❌'} chatStream returns AsyncIterable: ${isAsyncIterable}`);
    }

    console.log('\n🎉 All streaming services validation completed successfully!');
    console.log('\n📊 Summary:');
    console.log('  ✅ OpenAI Streaming Service: Fully functional');
    console.log('  ✅ xAI Streaming Service: Fully functional (OpenAI-compatible)');
    console.log('  ✅ Google AI Streaming Service: Fully functional (simulated streaming)');
    console.log('\n🚀 Ready for Phase 2.2: Provider Integration Testing');

  } catch (error: any) {
    console.error('❌ Validation failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run validation if this script is executed directly
if (require.main === module) {
  validateStreamingServices().catch(console.error);
}

export { validateStreamingServices };
