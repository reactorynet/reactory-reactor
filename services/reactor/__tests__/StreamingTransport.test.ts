import { SSETransport, WebSocketTransport } from '../StreamingTransport';
import { StreamingEvent } from '../types/streaming.types';
import { Response } from 'express';

// Helper functions to reduce nesting complexity
const findCloseHandler = (mockRes: Response) => {
  const mockCalls = (mockRes.on as jest.Mock).mock.calls;
  const closeCall = mockCalls.find(call => call[0] === 'close');
  return closeCall?.[1];
};

const setupWriteError = (mockRes: Response, error: Error) => {
  (mockRes.write as jest.Mock).mockImplementation(() => {
    throw error;
  });
};

const setupSendError = (mockWs: MockWebSocket, error: Error) => {
  mockWs.send.mockImplementation(() => {
    throw error;
  });
};

// Mock Express Response
const mockResponse = () => {
  const res = {
    writeHead: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    headersSent: false,
    finished: false,
  } as unknown as Response;
  return res;
};

// Mock WebSocket
class MockWebSocket {
  readyState = 1; // OPEN
  onopen?: () => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (event: { data: string }) => void;
  
  send = jest.fn();
  close = jest.fn();
  
  // Simulate WebSocket events
  simulateOpen() {
    this.onopen?.();
  }
  
  simulateClose() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  
  simulateError(error: Error) {
    this.onerror?.(error);
  }
  
  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

describe('StreamingTransport', () => {
  describe('SSETransport', () => {
    let mockRes: Response;
    let transport: SSETransport;
    
    beforeEach(() => {
      mockRes = mockResponse();
      transport = new SSETransport(mockRes);
    });
    
    afterEach(() => {
      jest.clearAllMocks();
    });
    
    describe('constructor', () => {
      it('should create SSETransport with response object', () => {
        expect(transport).toBeInstanceOf(SSETransport);
        expect(transport.isConnected).toBe(false);
      });
    });
    
    describe('initialize', () => {
      it('should set up SSE headers and mark as connected', async () => {
        await transport.initialize();
        
        expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(mockRes.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
        expect(transport.isConnected).toBe(true);
      });
      
      it('should throw error if already initialized', async () => {
        await transport.initialize();
        
        await expect(transport.initialize()).rejects.toThrow('SSE transport already initialized');
      });
      
      it('should set up close event listener', async () => {
        await transport.initialize();
        
        expect(mockRes.on).toHaveBeenCalledWith('close', expect.any(Function));
      });
    });
    
    describe('sendEvent', () => {
      const mockEvent: StreamingEvent = {
        type: 'token',
        sessionId: 'test-session-123',
        conversationId: 'test-conversation-456',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        data: {
          content: 'Hello',
          delta: 'Hello',
          position: 0,
          isComplete: false
        }
      };
      
      it('should send properly formatted SSE event', async () => {
        await transport.initialize();
        await transport.sendEvent(mockEvent);
        
        const expectedData = JSON.stringify(mockEvent);
        expect(mockRes.write).toHaveBeenCalledWith(
          `event: ${mockEvent.type}\ndata: ${expectedData}\n\n`
        );
      });
      
      it('should throw error if not initialized', async () => {
        await expect(transport.sendEvent(mockEvent))
          .rejects.toThrow('SSE transport not initialized');
      });
      
      it('should handle write errors gracefully', async () => {
        await transport.initialize();
        const writeError = new Error('Write failed');
        setupWriteError(mockRes, writeError);
        
        await expect(transport.sendEvent(mockEvent))
          .rejects.toThrow('Write failed');
      });
    });
    
    describe('close', () => {
      it('should end response and mark as disconnected', async () => {
        await transport.initialize();
        await transport.close();
        
        expect(mockRes.end).toHaveBeenCalled();
        expect(transport.isConnected).toBe(false);
      });
      
      it('should be idempotent', async () => {
        await transport.initialize();
        await transport.close();
        await transport.close(); // Should not throw
        
        expect(mockRes.end).toHaveBeenCalledTimes(1);
      });
    });
    
    describe('error handling', () => {
      it('should handle response close event', async () => {
        await transport.initialize();
        
        // Get the close handler using helper function
        const closeHandler = findCloseHandler(mockRes);
        
        // Simulate response close
        if (closeHandler) {
          closeHandler();
        }
        
        expect(transport.isConnected).toBe(false);
      });
    });
  });
  
  describe('WebSocketTransport', () => {
    let mockWs: MockWebSocket;
    let transport: WebSocketTransport;
    
    beforeEach(() => {
      mockWs = new MockWebSocket();
      transport = new WebSocketTransport(mockWs as any);
    });
    
    afterEach(() => {
      jest.clearAllMocks();
    });
    
    describe('constructor', () => {
      it('should create WebSocketTransport with WebSocket object', () => {
        expect(transport).toBeInstanceOf(WebSocketTransport);
        expect(transport.isConnected).toBe(false);
      });
    });
    
    describe('initialize', () => {
      it('should set up WebSocket event handlers and mark as connected', async () => {
        await transport.initialize();
        
        expect(mockWs.onopen).toBeDefined();
        expect(mockWs.onclose).toBeDefined();
        expect(mockWs.onerror).toBeDefined();
        expect(transport.isConnected).toBe(true);
      });
      
      it('should throw error if already initialized', async () => {
        await transport.initialize();
        
        await expect(transport.initialize()).rejects.toThrow('WebSocket transport already initialized');
      });
      
      it('should handle WebSocket ready states correctly', async () => {
        mockWs.readyState = 0; // CONNECTING
        transport = new WebSocketTransport(mockWs as any);
        
        await transport.initialize();
        
        // Should be marked as connected after initialization, regardless of readyState
        expect(transport.isConnected).toBe(false); // Because readyState is not OPEN (1)
        
        // Simulate WebSocket opening
        mockWs.readyState = 1; // OPEN
        mockWs.simulateOpen();
        
        expect(transport.isConnected).toBe(true);
      });
    });
    
    describe('sendEvent', () => {
      const mockEvent: StreamingEvent = {
        type: 'token',
        sessionId: 'test-session-123',
        conversationId: 'test-conversation-456',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        data: {
          content: 'Hello',
          delta: 'Hello',
          position: 0,
          isComplete: false
        }
      };
      
      it('should send JSON stringified event via WebSocket', async () => {
        await transport.initialize();
        await transport.sendEvent(mockEvent);
        
        const expectedData = JSON.stringify(mockEvent);
        expect(mockWs.send).toHaveBeenCalledWith(expectedData);
      });
      
      it('should throw error if not initialized', async () => {
        await expect(transport.sendEvent(mockEvent))
          .rejects.toThrow('WebSocket transport not initialized');
      });
      
      it('should throw error if WebSocket is not open', async () => {
        await transport.initialize();
        mockWs.readyState = 3; // CLOSED
        
        await expect(transport.sendEvent(mockEvent))
          .rejects.toThrow('WebSocket is not open');
      });
      
      it('should handle send errors gracefully', async () => {
        await transport.initialize();
        const sendError = new Error('Send failed');
        setupSendError(mockWs, sendError);
        
        await expect(transport.sendEvent(mockEvent))
          .rejects.toThrow('Send failed');
      });
    });
    
    describe('close', () => {
      it('should close WebSocket and mark as disconnected', async () => {
        await transport.initialize();
        await transport.close();
        
        expect(mockWs.close).toHaveBeenCalled();
        expect(transport.isConnected).toBe(false);
      });
      
      it('should be idempotent', async () => {
        await transport.initialize();
        await transport.close();
        await transport.close(); // Should not throw
        
        expect(mockWs.close).toHaveBeenCalledTimes(1);
      });
    });
    
    describe('event handling', () => {
      it('should handle WebSocket close event', async () => {
        await transport.initialize();
        
        mockWs.simulateClose();
        
        expect(transport.isConnected).toBe(false);
      });
      
      it('should handle WebSocket error event', async () => {
        await transport.initialize();
        const error = new Error('WebSocket error');
        
        // Should not throw, just handle gracefully
        mockWs.simulateError(error);
        
        expect(transport.isConnected).toBe(false);
      });
    });
  });
  
  describe('Transport Interface Compliance', () => {
    it('should implement StreamingTransport interface correctly', () => {
      const mockRes = mockResponse();
      const sseTransport = new SSETransport(mockRes);
      
      // Check that all required methods exist
      expect(typeof sseTransport.initialize).toBe('function');
      expect(typeof sseTransport.sendEvent).toBe('function');
      expect(typeof sseTransport.close).toBe('function');
      expect(typeof sseTransport.isConnected).toBe('boolean');
    });
    
    it('should handle transport lifecycle consistently', async () => {
      const mockRes = mockResponse();
      const transport = new SSETransport(mockRes);
      
      // Initial state
      expect(transport.isConnected).toBe(false);
      
      // After initialization
      await transport.initialize();
      expect(transport.isConnected).toBe(true);
      
      // After close
      await transport.close();
      expect(transport.isConnected).toBe(false);
    });
  });
});
