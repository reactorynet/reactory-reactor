import yaml from 'js-yaml';
import { ChatState, Macro, MacroComponentDefinition } from "@reactory/server-modules/reactory-reactor/ai/openai/types/chat";
import { URL } from 'url';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import logger from '@reactory/server-core/logging';
import { StreamingMode } from "modules/reactory-reactor/services/reactor/types/streaming.types";
import { IReactorConversationsService } from '../../../types/service.types';
import {
  HttpMacroProps,
  GetMacroProps,
  PostMacroProps,
  PutMacroProps,
  DeleteMacroProps,
  PatchMacroProps,
  FetchMacroProps,
  HttpMacroResult
} from './types';

/** Default response size (in characters) above which the body is replaced in `data.content` with a file reference. */
const DEFAULT_INLINE_THRESHOLD = 20_000;
/** Default maximum number of plain-text characters sent to the child summarizer session. */
const DEFAULT_SUMMARY_MAX_CHARS = 100_000;

/** Tags whose open/close should introduce a line break so block structure survives HTML stripping. */
const HTML_BLOCK_TAGS = [
  'br', 'p', 'div', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
  'header', 'footer', 'nav', 'blockquote', 'pre', 'hr',
];

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ',
};

const shortHash = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 12);

const sanitizePathSegment = (s: string): string =>
  (s || '').replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Resolve the workspace folder where cached web bodies should be written for
 * the current session. Prefers `state.sessionFolder` (populated from the
 * conversation document virtual); falls back to a data-root derived path or
 * an OS tmp dir so the macro still works in CLI / un-persisted sessions.
 */
const resolveCacheRoot = (state: ChatState): string | null => {
  if (state.sessionFolder) return state.sessionFolder;
  const dataRoot = process.env.REACTORY_DATA || process.env.APP_DATA_ROOT;
  const userId = sanitizePathSegment(
    ((state.user as any)?._id ?? state.user)?.toString() || 'anon'
  );
  const personaId = sanitizePathSegment(state.personaId || 'reactor');
  const conversationId = sanitizePathSegment(state.id || 'session');
  if (dataRoot) {
    return path.join(dataRoot, 'profiles', userId, 'chats', personaId, conversationId);
  }
  return path.join(os.tmpdir(), 'reactory-web', userId, personaId, conversationId);
};

const extensionForContentType = (contentType: string, returnFormat: string): string => {
  const ct = (contentType || '').toLowerCase();
  if (returnFormat === 'json' || ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('css')) return 'css';
  return 'txt';
};

const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|#39|#x27|apos|nbsp);/g, (m) => HTML_ENTITY_MAP[m] ?? m);

/**
 * Strip an HTML document down to readable plain text without pulling in a
 * dependency. Removes scripts, styles, comments and tags; turns block-level
 * elements into newlines so the summarizer sees structure rather than a
 * single run-on line.
 */
export const htmlToPlainText = (html: string): string => {
  let s = html || '';
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<template[\s\S]*?<\/template>/gi, '');
  const blockPattern = new RegExp(`</?(?:${HTML_BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi');
  s = s.replace(blockPattern, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeHtmlEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
};

interface CachedFile {
  path: string;
  size: number;
}

const writeCacheFile = async (
  cacheRoot: string,
  content: string,
  ext: string,
  prefix: string,
): Promise<CachedFile> => {
  const webDir = path.join(cacheRoot, 'web');
  await fs.mkdir(webDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${shortHash(content)}.${ext}`;
  const filePath = path.join(webDir, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  const stats = await fs.stat(filePath);
  return { path: filePath, size: stats.size };
};

interface SummarizerOptions {
  personaId?: string;
  focus?: string;
  maxChars?: number;
  cachedTextPath?: string;
  sourceUrl?: string;
}

interface SummarizerResult {
  summary: string;
  conversationId?: string;
}

/**
 * Spawn a child agent session to summarize the extracted plain text. The
 * large body lives in the child session's context; only the produced summary
 * is returned to the parent agent so the parent's context window is preserved.
 */
const summarizeWithChildSession = async (
  state: ChatState,
  plainText: string,
  opts: SummarizerOptions,
): Promise<SummarizerResult> => {
  const conversationService = state.context?.getService<IReactorConversationsService>(
    "reactor.ReactorConversationService@1.0.0",
  );
  if (!conversationService) {
    throw new Error('ReactorConversationService is not available in the current context');
  }
  const personaId = opts.personaId || state.personaId;
  const maxChars = opts.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const truncated = plainText.length > maxChars;
  const body = truncated ? plainText.slice(0, maxChars) : plainText;

  const lines: string[] = [
    'You are a content summarizer. Read the text extracted from a web page below and produce a concise, structured markdown summary.',
    `Source URL: ${opts.sourceUrl || 'unknown'}`,
  ];
  if (opts.focus) lines.push(`Focus your summary on: ${opts.focus}`);
  if (truncated) {
    lines.push(
      `Note: The full extracted text is ${plainText.length} characters; only the first ${maxChars} are included below. The complete text is cached at ${opts.cachedTextPath || '(not cached)'}.`,
    );
  }
  lines.push('');
  lines.push('Return:');
  lines.push('- A 3-5 sentence high-level overview.');
  lines.push('- Key points as a bulleted list (max 8 items).');
  lines.push('- Notable data, links, or entities (if any).');
  lines.push('- A short note distinguishing primary content from navigation/boilerplate, where obvious.');
  lines.push('');
  lines.push('--- BEGIN TEXT ---');
  lines.push(body);
  lines.push('--- END TEXT ---');

  const response = await conversationService.sendMessage({
    personaId,
    message: lines.join('\n'),
    parentSessionId: state.id,
    streamingMode: StreamingMode.NONE,
  });

  const summary = (response?.content || response?.message || '').toString();
  return { summary, conversationId: response?.sessionId };
};

/**
 * Utility function to parse string options in format "key=value,key2=value2" or YAML format
 */
const parseStringOptions = (optionsString: string): Record<string, string> => {
  if (!optionsString) return {};
  
  // Check if the input might be YAML
  const trimmedStr = optionsString.trim();
  if (
    trimmedStr.startsWith('---') || 
    trimmedStr.includes('\n') ||
    trimmedStr.match(/^\s*[\w-]+:\s*/)
  ) {
    try {
      // Try to parse as YAML
      const parsed = yaml.load(trimmedStr);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    } catch (e) {
      // If YAML parsing fails, fall back to the original method
      console.warn('Failed to parse as YAML, falling back to simple parsing:', e);
    }
  }
  
  // Original key=value parsing
  return optionsString.split(',').reduce((acc, pair) => {
    const [key, value] = pair.split('=').map(part => part.trim());
    if (key && value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, string>);
};

/**
 * Base HTTP macro that handles all HTTP requests
 */
export const HttpMacro: Macro<HttpMacroResult, HttpMacroProps> = async (
  props: HttpMacroProps,
  state: ChatState): Promise<HttpMacroResult> => {
  const startTime = Date.now();
  const {
    url,
    method,
    options,
    returnFormat = 'text',
    cacheToWorkspace = true,
    inlineThreshold = DEFAULT_INLINE_THRESHOLD,
    summarize = false,
    summaryPersonaId,
    summaryFocus,
    summaryMaxChars = DEFAULT_SUMMARY_MAX_CHARS,
  } = props;
  
  if (!url) {
    return {
      success: false,
      error: 'URL is required',
      tool: 'http',
      params: props
    };
  }

  try {
    // Validate URL
    const parsedUrl = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        success: false,
        error: 'Invalid URL protocol. Only http and https are allowed.',
        tool: 'http',
        params: props
      };
    }
    
    // Process options
    let requestInit: RequestInit = { method };
    
    if (options) {
      if (typeof options === 'string') {
        // Parse string options
        const parsedOptions = parseStringOptions(options);
        
        // Handle common options
        if (parsedOptions.headers) {
          try {
            requestInit.headers = JSON.parse(parsedOptions.headers);
          } catch (e) {
            return {
              success: false,
              error: 'Invalid headers format in options string',
              tool: 'http',
              params: props
            };
          }
        }
        
        if (parsedOptions.body) {
          requestInit.body = parsedOptions.body;
        }
        
        // Add other options directly
        Object.entries(parsedOptions).forEach(([key, value]) => {
          if (!['headers', 'body'].includes(key)) {
            (requestInit as any)[key] = value;
          }
        });
      } else if (typeof options === 'function') {
        // Handle async function options
        const functionResult = await options();
        requestInit = { ...requestInit, ...functionResult };
      } else if (typeof options === 'object') {
        // Handle object options
        requestInit = { ...requestInit, ...options };
      }
    }
    
    const requestStartTime = Date.now();
    const response = await fetch(parsedUrl.href, requestInit);
    const responseTime = Date.now() - requestStartTime;
    const executionTime = Date.now() - startTime;

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP error! status: ${response.status} ${response.statusText}`,
        tool: 'http',
        params: props,
        metadata: {
          executionTime,
          timestamp: new Date(),
          user: state.user?.id,
          url: parsedUrl.href,
          method
        }
      };
    }
    
    let content;
    const contentType = response.headers.get('content-type') || 'text/plain';
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    
    switch (returnFormat.toLowerCase()) {
      case 'json':
        content = await response.json();
        break;
      case 'text':
        content = await response.text();
        break;
      case 'blob':
        const blob = await response.blob();
        content = {
          type: blob.type,
          size: blob.size,
          data: 'Blob data (not serializable)'
        };
        break;
      default:
        return {
          success: false,
          error: 'Unsupported return format. Use "json", "text", or "blob".',
          tool: 'http',
          params: props,
          metadata: {
            executionTime,
            timestamp: new Date(),
            user: state.user?.id,
            url: parsedUrl.href,
            method
          }
        };
    }

    // Convert headers to plain object
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // --- Cache large bodies to the agent's session workspace -----------------
    // The raw body can be tens of MBs for HTML pages; inlining it into the
    // tool result bloats the parent agent's context. Cache it to a file under
    // the session folder and replace `content` with a reference when it
    // exceeds `inlineThreshold`.
    const cacheRoot = resolveCacheRoot(state);
    const contentIsString = typeof content === 'string';
    const isHtmlBody = contentType.toLowerCase().includes('html');
    const urlHash = shortHash(parsedUrl.href);
    const methodStem = method.toLowerCase();

    let cachedPath: string | undefined;
    let cachedSize: number | undefined;
    let textPath: string | undefined;
    let textSize: number | undefined;
    let summary: string | undefined;
    let summaryConversationId: string | undefined;
    let inlined = true;
    let inlineContent: any = content;

    if (cacheToWorkspace && contentIsString && cacheRoot) {
      try {
        const ext = extensionForContentType(contentType, returnFormat);
        const cached = await writeCacheFile(cacheRoot, content, ext, `${methodStem}-${urlHash}`);
        cachedPath = cached.path;
        cachedSize = cached.size;
      } catch (err) {
        logger.warn(
          `HttpMacro: failed to cache response body for ${parsedUrl.href}: ${(err as Error).message}`,
        );
      }
    }

    if (contentIsString && content.length > inlineThreshold) {
      inlined = false;
      inlineContent = {
        cached: true,
        path: cachedPath,
        size: cachedSize ?? content.length,
        contentType,
        message:
          'Response body was too large to inline and has been cached to the workspace file above. Use `readFile` (or `snip` for a line range) to inspect it.',
      };
    }

    if (summarize && isHtmlBody && contentIsString) {
      try {
        const plainText = htmlToPlainText(content);
        if (cacheRoot) {
          try {
            const txt = await writeCacheFile(
              cacheRoot,
              plainText,
              'txt',
              `${methodStem}-text-${urlHash}`,
            );
            textPath = txt.path;
            textSize = txt.size;
          } catch (err) {
            logger.warn(
              `HttpMacro: failed to cache extracted text for ${parsedUrl.href}: ${(err as Error).message}`,
            );
          }
        }
        const summarizerResult = await summarizeWithChildSession(state, plainText, {
          personaId: summaryPersonaId,
          focus: summaryFocus,
          maxChars: summaryMaxChars,
          cachedTextPath: textPath,
          sourceUrl: parsedUrl.href,
        });
        summary = summarizerResult.summary;
        summaryConversationId = summarizerResult.conversationId;
      } catch (err) {
        logger.warn(
          `HttpMacro: summarization failed for ${parsedUrl.href}: ${(err as Error).message}`,
        );
      }
    }

    // Store in chat state for AI reference
    if (!state.vars) {
      state.vars = {};
    }
    state.vars.lastHttpRequest = {
      url: parsedUrl.href,
      method,
      status: response.status,
      responseTime,
      contentType,
      contentLength,
      cachedPath,
      cachedSize,
      textPath,
      textSize,
      summary,
      summaryConversationId,
      lastAccessed: new Date()
    };

    // Log request for security
    logger.info(`HttpMacro executed: ${method} ${parsedUrl.href} by user: ${state.user?.id || 'unknown'}, status: ${response.status}`);

    const sizeFormatted = (bytes: number | undefined): string => {
      if (bytes === undefined) return 'unknown';
      if (bytes < 1024) return `${bytes}B`;
      return `${(bytes / 1024).toFixed(2)}KB`;
    };

    const cachingSection = [
      '### Cached to Workspace:',
      `- **Inlined**: ${inlined ? 'yes — full body in `content`' : 'no — `content` is a reference; body is on disk'}`,
      cachedPath ? `- **Cached Body**: \`${cachedPath}\` (${sizeFormatted(cachedSize)})` : '- **Cached Body**: (not cached)',
      textPath ? `- **Extracted Text**: \`${textPath}\` (${sizeFormatted(textSize)})` : '',
    ].filter(Boolean).join('\n');

    const summarySection = summary
      ? [
          '### Summary (produced by child summarizer session):',
          '',
          summary,
          '',
          summaryConversationId ? `- **Summarizer Conversation**: \`${summaryConversationId}\` (use \`chats\` action \`followup\` to ask follow-up questions about this page)` : '',
        ].join('\n')
      : (summarize && isHtmlBody
          ? '### Summary:\nSummarization was requested but could not be completed. See the cached body / extracted text files above and summarize manually if needed.'
          : '### Summary:\n(not requested — set `summarize: true` on a future call to spawn a child summarizer session for HTML responses)');

    return {
      success: true,
      data: {
        url: parsedUrl.href,
        method,
        status: response.status,
        statusText: response.statusText,
        headers,
        content: inlineContent,
        responseTime,
        contentLength,
        contentType,
        inlined,
        cachedPath,
        cachedSize,
        textPath,
        textSize,
        summary,
        summaryConversationId
      },
      tool: 'http',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        url: parsedUrl.href,
        method
      },
      instructions: `
## HTTP Request Results

Successfully completed ${method} request to: **${parsedUrl.hostname}**

### Request Information:
- **URL**: ${parsedUrl.href}
- **Method**: ${method}
- **Status**: ${response.status} ${response.statusText}
- **Response Time**: ${responseTime}ms
- **Content Type**: ${contentType}
- **Content Length**: ${contentLength} bytes
- **Total Execution Time**: ${executionTime}ms

${cachingSection}

${summarySection}

### Available Data:
- **content**: ${inlined ? 'Response content (formatted according to returnFormat)' : 'Reference object pointing at the cached body file — read the file for the full payload'}
- **headers**: Response headers as key-value pairs
- **status**: HTTP status code
- **statusText**: HTTP status text
- **responseTime**: Time taken for the HTTP request
- **contentLength**: Size of response content
- **contentType**: MIME type of response
- **cachedPath / cachedSize**: Workspace path and byte size of the cached body (when caching is enabled)
- **textPath / textSize**: Workspace path and byte size of the plain-text extraction (when \`summarize\` is used on HTML)
- **summary**: Summary text from the child summarizer session (when \`summarize\` is used)

### State Variables Available:
- lastHttpRequest: Complete request information for future reference (including cachedPath, textPath, summary)

### Usage:
- Use \`readFile\` or \`snip\` against \`cachedPath\` to inspect the raw body without re-fetching
- Use \`readFile\` against \`textPath\` to inspect the plain-text extraction
- Use \`chats\` action \`followup\` with id \`${summaryConversationId || '<summaryConversationId>'}\` to ask follow-up questions about the summarized page
      `
    };

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`Error in HTTP request to ${url}:`, err);
    
    return {
      success: false,
      error: `HTTP request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      tool: 'http',
      params: props,
      metadata: {
        executionTime,
        timestamp: new Date(),
        user: state.user?.id,
        url: url.trim(),
        method
      }
    };
  }
};

/**
 * HTTP verb-specific macros
 */
export const GetMacro: Macro<HttpMacroResult, GetMacroProps> = async (props: GetMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: 'GET', options, returnFormat: format, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

export const PostMacro: Macro<HttpMacroResult, PostMacroProps> = async (props: PostMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: 'POST', options, returnFormat: format, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

export const PutMacro: Macro<HttpMacroResult, PutMacroProps> = async (props: PutMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: 'PUT', options, returnFormat: format, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

export const DeleteMacro: Macro<HttpMacroResult, DeleteMacroProps> = async (props: DeleteMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: 'DELETE', options, returnFormat: format, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

export const PatchMacro: Macro<HttpMacroResult, PatchMacroProps> = async (props: PatchMacroProps, state: ChatState): Promise<HttpMacroResult> => {
  const { url, format = 'text', options, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: 'PATCH', options, returnFormat: format, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

/**
 * Legacy FetchMacro for backward compatibility
 */
export const FetchMacro: Macro<HttpMacroResult, FetchMacroProps> = async (
  props: FetchMacroProps,
  state: ChatState): Promise<HttpMacroResult> => {
  const { url, requestInit, returnFormat = 'text', cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars } = props;
  return HttpMacro({ url, method: requestInit?.method || 'GET', options: requestInit, returnFormat, cacheToWorkspace, inlineThreshold, summarize, summaryPersonaId, summaryFocus, summaryMaxChars }, state);
};

/**
 * Macro registry entries
 */

/**
 * Tool schema fragments shared by every web/http verb tool. These expose the
 * caching and summarizer controls to the agent so it can request a summary or
 * tune inline behaviour on a per-call basis.
 */
const WEB_TOOL_EXTRA_PARAMS = {
  cacheToWorkspace: {
    type: "boolean",
    description: "When true (default), write the response body to a file under the agent's session workspace and report its path + size. Disable only for tiny responses where caching is unnecessary."
  },
  inlineThreshold: {
    type: "number",
    description: "Responses larger than this many characters are replaced in `content` with a reference to the cached file (default 20000). Decrease to keep context lean; increase to inline larger bodies."
  },
  summarize: {
    type: "boolean",
    description: "When true and the response is HTML, strip the HTML to plain text and spawn a child agent session to produce a structured summary. The summary is returned in place of the raw body to keep the parent context small."
  },
  summaryPersonaId: {
    type: "string",
    description: "Optional persona id for the summarizer child session. Defaults to the current session persona. Use `chats` action `personas` to list valid ids."
  },
  summaryFocus: {
    type: "string",
    description: "Optional guidance for what the summarizer should focus on (e.g. 'extract pricing tiers' or 'summarize the API documentation')."
  },
  summaryMaxChars: {
    type: "number",
    description: "Maximum number of plain-text characters to send to the summarizer (default 100000). The full extracted text is always cached to a file regardless of this limit."
  },
};

export const HttpMacroRegistry: MacroComponentDefinition<typeof HttpMacro> = {
  nameSpace: 'reactor-macros',
  name: 'http',
  version: '1.0.0',
  component: HttpMacro,
  description: 'A base macro for HTTP requests with structured results and metadata',
  features: [],
  stem: 'http',
  roles: ['USER'],
  tags: ['http', 'fetch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "http",
      description: "Make an HTTP request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "http",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the request to"
          },
          method: {
            type: "string",
            description: "The HTTP method to use"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          returnFormat: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url", "method"]
      }
    }
  }]
};

export const GetMacroRegistry: MacroComponentDefinition<typeof GetMacro> = {
  nameSpace: 'reactor-macros',
  name: 'get',
  version: '1.0.0',
  component: GetMacro,
  description: 'A macro for HTTP GET requests with structured results and metadata',
  features: [],
  stem: 'get',
  roles: ['USER'],
  tags: ['http', 'get', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "get",
      description: "Make an HTTP GET request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "get_app",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the GET request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const PostMacroRegistry: MacroComponentDefinition<typeof PostMacro> = {
  nameSpace: 'reactor-macros',
  name: 'post',
  version: '1.0.0',
  component: PostMacro,
  roles: ['USER'],
  description: 'A macro for HTTP POST requests with structured results and metadata',
  features: [],
  stem: 'post',
  tags: ['http', 'post', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "post",
      description: "Make an HTTP POST request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "send",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the POST request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const PutMacroRegistry: MacroComponentDefinition<typeof PutMacro> = {
  nameSpace: 'reactor-macros',
  name: 'put',
  version: '1.0.0',
  component: PutMacro,
  description: 'A macro for HTTP PUT requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'put',
  tags: ['http', 'put', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "put",
      description: "Make an HTTP PUT request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "edit",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the PUT request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const DeleteMacroRegistry: MacroComponentDefinition<typeof DeleteMacro> = {
  nameSpace: 'reactor-macros',
  name: 'delete',
  version: '1.0.0',
  component: DeleteMacro,
  description: 'A macro for HTTP DELETE requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'delete',
  tags: ['http', 'delete', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "delete",
      description: "Make an HTTP DELETE request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "delete",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the DELETE request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const PatchMacroRegistry: MacroComponentDefinition<typeof PatchMacro> = {
  nameSpace: 'reactor-macros',
  name: 'patch',
  version: '1.0.0',
  component: PatchMacro,
  description: 'A macro for HTTP PATCH requests with structured results and metadata',
  roles: ['USER'],
  features: [],
  stem: 'patch',
  tags: ['http', 'patch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "patch",
      description: "Make an HTTP PATCH request with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "update",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the PATCH request to"
          },
          format: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          options: {
            type: "object",
            description: "Request options (can be a string, object, or function)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const FetchMacroRegistry: MacroComponentDefinition<typeof FetchMacro> = {
  nameSpace: 'reactor-macros',
  name: 'fetch',
  version: '1.0.0',
  component: FetchMacro,
  description: 'Legacy fetch macro for backward compatibility with structured results and metadata',
  features: [],
  stem: 'fetch',
  roles: ['USER'],
  tags: ['http', 'fetch', 'url', 'api'],
  tools: [{
    type: "function",
    function: {
      name: "fetch",
      description: "Legacy fetch macro for HTTP requests with comprehensive response metadata. Large response bodies are cached to the agent's session workspace; set `summarize: true` for HTML responses to spawn a child summarizer session and return a concise summary instead of the raw body.",
      icon: "cloud_download",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to send the request to"
          },
          requestInit: {
            type: "object",
            description: "Request initialization options"
          },
          returnFormat: {
            type: "string",
            description: "The format to return the data in (text, json, blob)"
          },
          ...WEB_TOOL_EXTRA_PARAMS
        },
        required: ["url"]
      }
    }
  }]
};

export const WebMacros: Reactory.IReactoryComponentDefinition<Macro<unknown>>[] = [
  FetchMacroRegistry,
  HttpMacroRegistry,
  GetMacroRegistry,
  PostMacroRegistry,
  PutMacroRegistry,
  DeleteMacroRegistry,
  PatchMacroRegistry
];