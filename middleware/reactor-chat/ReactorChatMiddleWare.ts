import Express, { Response } from "express";
import http from "http";
import logger from "@reactory/server-core/logging";
import passport from "passport";
import { StreamingEndpoints } from "@reactory/server-modules/reactory-reactor/services/reactor/StreamingEndpoints";
import { StreamingSessionManager } from "@reactory/server-modules/reactory-reactor/services/reactor/StreamingSessionManager";
import { StreamingTransportManager } from "@reactory/server-modules/reactory-reactor/services/reactor/StreamingTransportManager";
import RedisService from "@reactory/server-modules/reactory-core/services/RedisService";
import ReactoryContextProvider from "@reactory/server-core/context/ReactoryContextProvider";
import UserService from "@reactory/server-modules/reactory-core/services/UserService";
/**
 * Middleware to set up and configure MCP server
 * @param app Express application instance
 * @param httpServer HTTP server instance
 */
const ReactorChatStreamingMiddleware = async (
  app: Express.Application,
  httpServer: http.Server
) => {
  try {
    console.log('🔌 [ReactorChatMiddleware] Starting Reactor Chat Streaming Middleware');
    console.log('🔌 [ReactorChatMiddleware] App details:', {
      hasApp: !!app,
      appType: app.constructor.name,
      hasHttpServer: !!httpServer,
      httpServerType: httpServer?.constructor.name
    });
    
    // Check if StreamingEndpoints is available
    if (typeof StreamingEndpoints === 'undefined') {
      throw new Error('StreamingEndpoints is not defined');
    }
    
    if (typeof StreamingEndpoints.setupRoutes !== 'function') {
      throw new Error('StreamingEndpoints.setupRoutes is not a function');
    }
    
    console.log('🔌 [ReactorChatMiddleware] Setting up streaming routes');
    StreamingEndpoints.setupRoutes(app);    
    console.log('✅ [ReactorChatMiddleware] Reactor Chat Streaming Middleware started successfully');
    
    // Log the routes that were added
    console.log('🔌 [ReactorChatMiddleware] Routes added to app');
    if (app._router && app._router.stack) {
      app._router.stack.forEach((layer: any, index: number) => {
        if (layer.route) {
          console.log(`  - ${layer.route.stack[0].method.toUpperCase()} ${layer.route.path}`);
        }
      });
    }
    
  } catch (error) {
    console.error(`❌ [ReactorChatMiddleware] Error starting Reactor Chat Streaming Middleware:`, error);
    console.error(`❌ [ReactorChatMiddleware] Error details:`, {
      errorMessage: error.message,
      errorStack: error.stack,
      errorName: error.name
    });
    logger.error(`Error starting Reactor Chat Streaming Middleware: ${error.message}`);
  }
};

const ReactorChatStreamingMiddlewareDefinition: Reactory.Server.ReactoryMiddlewareDefinition =
  {
    nameSpace: "reactor",
    name: "ReactorChatStreamingMiddleware",
    version: "1.0.0",
    description: "Middleware for setting up the MCP server",
    component: ReactorChatStreamingMiddleware,
    ordinal: 20, // Adjust the ordinal based on when this middleware should be executed
    type: "configuration",
    async: true,
  };

export default ReactorChatStreamingMiddlewareDefinition;
