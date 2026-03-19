/**
 * TransportFactory — Creates the appropriate ChatTransport based on context.
 *
 * Strategy:
 *   1. If we have a Reactory DI context with the conversation service, use
 *      DirectTransport (in-process, optimal for bin/cli.sh).
 *   2. Otherwise fall back to HttpSseTransport using API_ENDPOINT + auth token.
 */
import { ChatTransport } from "../types";
import { DirectTransport } from "./DirectTransport";
import { HttpSseTransport, HttpSseTransportOptions } from "./HttpSseTransport";
import logger from "@reactory/server-core/logging";

export interface TransportFactoryOptions {
  /** Reactory DI context — available when running inside the server process */
  context?: Reactory.Server.IReactoryContext;
  /** HTTP fallback configuration */
  http?: HttpSseTransportOptions;
  /** Force a specific transport mode */
  forceMode?: "direct" | "http";
}

/**
 * Create a ChatTransport based on what's available.
 */
export function createTransport(opts: TransportFactoryOptions): ChatTransport {
  if (opts.forceMode === "http" && opts.http) {
    logger.info("[TransportFactory] Using HttpSseTransport (forced)");
    return new HttpSseTransport(opts.http);
  }

  if (opts.forceMode === "direct" && opts.context) {
    logger.info("[TransportFactory] Using DirectTransport (forced)");
    return new DirectTransport(opts.context);
  }

  // Auto-detection: prefer direct if context exists with the service
  if (opts.context) {
    try {
      const service = opts.context.getService(
        "reactor.ReactorConversationService@1.0.0"
      );
      if (service) {
        logger.info(
          "[TransportFactory] Using DirectTransport (auto-detected)"
        );
        return new DirectTransport(opts.context);
      }
    } catch {
      logger.warn(
        "[TransportFactory] ReactorConversationService not available via DI"
      );
    }
  }

  // Fall back to HTTP
  if (opts.http) {
    logger.info("[TransportFactory] Using HttpSseTransport (fallback)");
    return new HttpSseTransport(opts.http);
  }

  throw new Error(
    "[TransportFactory] No transport available. " +
      "Provide either a Reactory context (direct) or HTTP configuration."
  );
}
