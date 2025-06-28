import MCPRequestHandlers from "./MCPRequestHandlers";
import Express, { Response } from 'express';
import http from 'http';
import logger from '@reactory/server-core/logging';
import passport from 'passport';



/**
 * Middleware to set up and configure MCP server
 * @param app Express application instance
 * @param httpServer HTTP server instance
 */
const ReactoryMCP = async (app: Express.Application, httpServer: http.Server) => {
  try {
    
    
    // Add routes or middleware for MCP if needed
    app.get('/reactor-mcp/sse', passport.authenticate("jwt", { session: false }), async (req, res, next) => {    
      MCPRequestHandlers.handleSSERequest(req, res);
    });

    app.post('/reactor-mcp/messages', passport.authenticate("jwt", { session: false }), async (req, res, next) => { 
     MCPRequestHandlers.handeMessageRequest(req, res);
    });

    // Optional: Connect MCP server to existing HTTP server if needed
    // mcpServer.attachToHttpServer(httpServer);

    logger.info('✅ MCP server started successfully');
  } catch (error) {
    logger.error(`Error starting MCP server: ${error.message}`);
  }
};

const ReactoryMCPMiddlewareDefinition: Reactory.Server.ReactoryMiddlewareDefinition = {
  nameSpace: "core",
  name: "ReactoryMCPMiddleware",
  version: "1.0.0",
  description: "Middleware for setting up the MCP server",
  component: ReactoryMCP,
  ordinal: 20, // Adjust the ordinal based on when this middleware should be executed
  type: 'configuration',
  async: true
};

export default ReactoryMCPMiddlewareDefinition;
