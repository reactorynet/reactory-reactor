import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '@reactory/server-core/logging';
import Reactory from '@reactorynet/reactory-core';
import { ChatState } from '@reactory/server-modules/reactory-reactor/ai/openai/types/chat';

export interface ToolResultProcessorOptions {
  /** Maximum output size in characters/bytes before offloading to file. Default: 20000 */
  maxOutputSize?: number;
  /** Directory path to save output file to. Defaults to state workspace or os.tmpdir() */
  outputDir?: string;
  /** Optional custom file prefix, defaults to toolName */
  filePrefix?: string;
  /**
   * Per-field character budget used when curating an oversized `data` object.
   * Any string/array/object field whose stringified size exceeds this budget is
   * replaced with a compact `{ truncated: true, ... }` placeholder instead of
   * being kept in full. Default: 2000.
   */
  fieldBudget?: number;
  /**
   * Per-field character budget applied to `params` — the echoed request payload.
   *
   * Defaults to `fieldBudget`, because the same reasoning applies: bound what the result
   * carries. Applied unconditionally rather than only when the result exceeds
   * `maxOutputSize` — see `curateParams`.
   */
  paramsBudget?: number;
}

export interface ProcessedToolResult {
  /** The processed (and potentially truncated) tool result */
  result: any;
  /** Whether the result was offloaded to disk and truncated */
  outputTruncated: boolean;
  /** Path to saved output file if truncated */
  outputFile?: string;
  /** Size of total output file in bytes if truncated */
  outputSize?: number;
}

export class ToolResultProcessor {
  /** Default per-field character budget applied when curating a `data` object. */
  private static readonly DEFAULT_FIELD_BUDGET = 2000;

  /** Replacement written in place of a credential value. */
  public static readonly REDACTED = '[REDACTED]';

  /** Marker substituted for a repeated object reference, so cycles stay serialisable. */
  private static readonly CIRCULAR = '[Circular]';

  /**
   * Marker substituted for a subtree deeper than {@link MAX_REDACTION_DEPTH}.
   *
   * Replacing rather than passing the subtree through is deliberate: the walk cannot
   * prove an unwalked subtree is clean, so it must not be returned. Real credential
   * payloads are shallow (User -> sessionInfo[] -> jwtPayload), so this only ever
   * fires on pathological nesting.
   */
  private static readonly DEPTH_LIMIT = '[DEPTH-LIMIT]';

  /**
   * Maximum object depth walked by {@link redactSensitive}.
   *
   * A cap rather than unbounded recursion: tool results can embed deeply nested
   * provider payloads and an adversarial or accidental graph must not overflow the
   * stack. Credentials in this platform are shallow (User -> sessionInfo[] ->
   * jwtPayload), so 12 levels is far deeper than anything real.
   *
   * The ceiling is fail-closed: once reached, the subtree is replaced with
   * {@link DEPTH_LIMIT}. Returning it uninspected would mean "too deep to check" was
   * silently reported as "clean".
   */
  private static readonly MAX_REDACTION_DEPTH = 12;

  /**
   * Field names whose values are credential material and must never reach the model.
   *
   * This is the last line of defence, not the first: macros must project their own
   * results (see the support/user macros) and services must select fields. It exists
   * because the only pass over a tool result used to bound *size*, so a payload that
   * happened to carry a serialised User document - password hash, `salt`,
   * `sessionInfo[].jwtPayload.refresh`, `authentications[].props.accessToken` - was
   * appended to the conversation, sent to the model provider and, when oversized,
   * also written to `*-output-*.json` in the agent workspace.
   *
   * Keys are compared after stripping non-alphanumerics and lower-casing, so
   * `set-cookie`, `setCookie` and `SET_COOKIE` are the same entry. Prefixed HTTP
   * spellings (`x-api-key`, `proxy-authorization`) are listed explicitly because
   * normalisation does not strip the prefix.
   */
  public static readonly SENSITIVE_KEYS: ReadonlySet<string> = new Set([
    'password',
    'salt',
    'sessioninfo',
    'authentications',
    'memberships',
    'jwttoken',
    'jwtpayload',
    'jwtpayloadjson',
    'refresh',
    'refreshtoken',
    'accesstoken',
    'apikey',
    'secret',
    'clientsecret',
    'authorization',
    'proxyauthorization',
    'xapikey',
    'setcookie',
  ]);

  /** Normalise a field name for comparison (case and punctuation insensitive). */
  private static normaliseKey(key: string): string {
    return String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  /** True when this field name holds credential material. */
  public static isSensitiveKey(key: string): boolean {
    return ToolResultProcessor.SENSITIVE_KEYS.has(ToolResultProcessor.normaliseKey(key));
  }

  /**
   * Deep-walk a tool result and replace credential values with the redaction marker.
   *
   * Applied to the whole result, which covers the three surfaces a macro returns:
   * `data` (the payload), `metadata` and the echoed `params`. It is deliberately
   * key-based and in place: the shape is preserved (the key survives, its value becomes
   * the marker) so existing consumers and renders keep working, and nothing that was
   * not already a credential changes identity. Arrays and nested objects are walked.
   *
   * Safety properties:
   *  - **Cycles**: a repeated object reference becomes the circular marker; the walk
   *    terminates and `JSON.stringify` still succeeds downstream.
   *  - **Very large objects**: traversal is bounded in depth, so it is O(nodes) time
   *    with a hard recursion ceiling. The ceiling is fail-closed: a subtree at the
   *    limit is replaced with the depth marker rather than returned uninspected.
   *  - **Special values**: Dates, Buffers and bson ObjectIds pass through untouched;
   *    walking them would either destroy the value or explode Mongoose internals.
   *  - **Mongoose documents** are converted with `toObject()` first, so the walk sees
   *    schema fields rather than internals.
   */
  public static redactSensitive<T = any>(value: T): T {
    return ToolResultProcessor.redactNode(value, 0, new WeakSet<object>()) as T;
  }

  private static redactNode(value: any, depth: number, seen: WeakSet<object>): any {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    // Values whose JSON form is already scalar/safe - do not walk their internals.
    if (value instanceof Date) return value;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;
    const bsonType = (value as any)._bsontype;
    if (bsonType === 'ObjectID' || bsonType === 'ObjectId' || bsonType === 'Long') return value;

    // Mongoose documents: walk the plain representation, not the document internals.
    let node: any = value;
    if (typeof (value as any).toObject === 'function') {
      try {
        node = (value as any).toObject({ virtuals: true, getters: false });
      } catch {
        node = value;
      }
    }

    // A node already on the current path is a cycle, not shared data: the same object
    // legitimately referenced twice (createdBy and updatedBy populated with one user
    // document) must be walked at each reference, so this set is an ancestor path and
    // is unwound on the way back up.
    if (seen.has(node)) return ToolResultProcessor.CIRCULAR;
    seen.add(node);

    try {
      // Fail closed: an unwalked subtree is replaced, never returned intact.
      if (depth >= ToolResultProcessor.MAX_REDACTION_DEPTH) {
        return ToolResultProcessor.DEPTH_LIMIT;
      }

      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index += 1) {
          node[index] = ToolResultProcessor.redactNode(node[index], depth + 1, seen);
        }
        return node;
      }

      for (const key of Object.keys(node)) {
        if (ToolResultProcessor.isSensitiveKey(key)) {
          node[key] = ToolResultProcessor.REDACTED;
          continue;
        }
        node[key] = ToolResultProcessor.redactNode(node[key], depth + 1, seen);
      }

      return node;
    } finally {
      seen.delete(node);
    }
  }

  /**
   * Matches a `key: value` / `key=value` pair in free text, so credential material can
   * be found in a payload that is not structured JSON (shell output, a rendered table,
   * `util.inspect` output, an HTML snippet).
   */
  private static readonly CREDENTIAL_TEXT_PATTERN =
    /("?[A-Za-z0-9_.-]+"?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;\]})]+)/g;

  /** A PBKDF2 password hash is recognisable by its algorithm prefix, wherever it sits. */
  private static readonly CREDENTIAL_VALUE_PATTERN = /pbkdf2\S*/gi;

  /** Textual replacement keeps the value quoted when it was quoted. */
  private static redactTextPair(_match: string, prefix: string, rawValue: string): string {
    const name = prefix.replace(/["'\s:=]/g, '');
    const leaf = name.split('.').pop() || name;
    if (!ToolResultProcessor.isSensitiveKey(leaf)) return _match;

    const first = rawValue.charAt(0);
    const quote = first === '"' || first === "'" ? first : '';
    return `${prefix}${quote}${ToolResultProcessor.REDACTED}${quote}`;
  }

  /**
   * Redact credential material from a **string** tool result.
   *
   * `redactSensitive()` is a structural walk, so it cannot see inside a string - and a
   * string result is a normal shape here: the graphql macro returns
   * `JSON.stringify(result)`, the data macros return `JSON.stringify(rows)`, and shell
   * output is a string. A string result above `maxOutputSize` used to be written to
   * `<tool>-output-*.log` verbatim, so a serialised User document in string form was
   * persisted to disk with its password hash and salt intact.
   *
   * Two passes, strongest first:
   *  1. If the string is a JSON document, parse it, redact it structurally and
   *     re-serialise - exactly the object guarantee, including nested keys.
   *  2. Otherwise scrub `key: value` pairs textually (by key name) and any
   *     credential-shaped value such as a password hash.
   */
  public static redactSensitiveText(value: string): string {
    if (typeof value !== 'string' || value.length === 0) return value;

    const head = value.trimStart().charAt(0);
    if (head === '{' || head === '[') {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object') {
          const redacted = ToolResultProcessor.redactSensitive(parsed);
          const indentMatch = value.match(/\n([ \t]+)\S/);
          return JSON.stringify(redacted, null, indentMatch ? indentMatch[1] : undefined);
        }
      } catch {
        // Not JSON: fall through to the textual scrub rather than persisting it raw.
      }
    }

    return ToolResultProcessor.scrubCredentialText(value);
  }

  /** Redact credential key/value pairs and credential-shaped values in free text. */
  private static scrubCredentialText(text: string): string {
    const scrubbed = text.replace(
      ToolResultProcessor.CREDENTIAL_TEXT_PATTERN,
      ToolResultProcessor.redactTextPair
    );

    return scrubbed.replace(
      ToolResultProcessor.CREDENTIAL_VALUE_PATTERN,
      ToolResultProcessor.REDACTED
    );
  }

  /** Notice attached to a curated `params` field, distinguishing it from curated output. */
  private static readonly PARAMS_NOTICE =
    'The request payload was omitted from this result to avoid echoing your own input back to ' +
    'you at full size. The tool received it in full. This is not a tool failure and no data was lost.';

  /**
   * Curates an oversized `data` object field-by-field instead of blanket-spreading
   * it back in. Any own key whose stringified value exceeds `fieldBudget` characters
   * is replaced with a compact `{ truncated: true, ... }` placeholder describing the
   * shape and size of what was removed (item count for arrays, char length for
   * strings, key count for nested objects). Small/short fields pass through untouched.
   *
   * This generalises the legacy `stdout`/`content` special-casing to ANY field
   * shape - results arrays, node arrays, duplicated code-block strings, etc. - so
   * every macro benefits, not just the ones whose bloat happens to live under one
   * of those two literal keys.
   */
  private static curateDataObject(
    data: Record<string, any>,
    noticeMessage: string,
    fieldBudget?: number
  ): Record<string, any> {
    const budget = fieldBudget && fieldBudget > 0 ? fieldBudget : ToolResultProcessor.DEFAULT_FIELD_BUDGET;
    const curated: Record<string, any> = {};
    // Legacy fields historically collapsed to the flat notice string rather than a
    // structured placeholder, so consumers that render/concatenate them as plain
    // text (e.g. shell output panes, file content viewers) keep working unchanged.
    const legacyStringFields = new Set(['stdout', 'content']);

    for (const [key, value] of Object.entries(data)) {
      if (legacyStringFields.has(key) && typeof value === 'string' && value.length > budget) {
        curated[key] = noticeMessage;
        continue;
      }
      curated[key] = ToolResultProcessor.curateField(value, budget, noticeMessage);
    }

    return curated;
  }

  private static curateField(value: any, budget: number, noticeMessage: string): any {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (value.length <= budget) return value;
      return {
        truncated: true,
        type: 'string',
        length: value.length,
        preview: value.slice(0, Math.min(200, budget)),
        notice: noticeMessage,
      };
    }

    if (Array.isArray(value)) {
      let size = 0;
      try {
        size = JSON.stringify(value).length;
      } catch {
        size = value.length * budget;
      }
      if (size <= budget) return value;
      return {
        truncated: true,
        type: 'array',
        itemCount: value.length,
        approxSize: size,
        preview: ToolResultProcessor.boundedPreview(value, budget),
        notice: noticeMessage,
      };
    }

    if (typeof value === 'object') {
      let size = 0;
      try {
        size = JSON.stringify(value).length;
      } catch {
        size = budget + 1;
      }
      if (size <= budget) return value;
      return {
        truncated: true,
        type: 'object',
        keyCount: Object.keys(value).length,
        approxSize: size,
        notice: noticeMessage,
      };
    }

    return value;
  }

  /**
   * A size-bounded textual preview of an oversized value.
   *
   * The previous array placeholder used `value.slice(0, 3)` — three items, each of which may be
   * arbitrarily large, so the "truncated" placeholder could itself be far bigger than the field it
   * replaced (a 3-item array of 100 KB objects produced a 300 KB "truncation"). This caps the
   * rendered preview at `limit` characters regardless of item size.
   */
  private static boundedPreview(value: any, limit: number): string {
    let rendered: string;
    try {
      rendered = JSON.stringify(value);
    } catch {
      rendered = String(value);
    }
    const cap = Math.max(0, Math.min(limit, 400));
    return rendered.length > cap ? `${rendered.slice(0, cap)}…` : rendered;
  }

  /**
   * Bound an echoed request payload (`result.params`).
   *
   * Macros conventionally return `params: props` — a restatement of the caller's own input. It is
   * part of the tool result, so it is appended to the conversation and paid for in tokens, yet
   * nothing consumes it. For a macro whose input is large (`writeFile.content`,
   * `safeEditFile.patches`, `mongoWrite.documents`) that is the request echoed back at full size.
   *
   * It also **defeated the gate below**: the truncation path curates `data` but left `params`
   * untouched, so an oversized result could have its `data` replaced with placeholders while still
   * carrying the entire payload in `params`.
   *
   * Bounded **unconditionally**, not only when the total exceeds `maxOutputSize`, because those
   * bytes are never worth carrying: a small result with a large `params` should not slip through
   * just because it happened to be under the threshold. Fields within budget pass through
   * untouched, so shapes and existing consumers are unaffected.
   */
  private static curateParams(params: any, budget: number): any {
    if (params === null || params === undefined) return params;

    if (typeof params !== 'object' || Array.isArray(params)) {
      return ToolResultProcessor.curateField(params, budget, ToolResultProcessor.PARAMS_NOTICE);
    }

    // Per key, like `data`: small values such as `path`, `mode` or `limit` stay readable.
    const curated: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      curated[key] = ToolResultProcessor.curateField(
        value,
        budget,
        ToolResultProcessor.PARAMS_NOTICE
      );
    }
    return curated;
  }

  /**
   * Replace an attached `params` with its bounded form.
   *
   * Only a `params` that is **already present** is replaced, so a tool that does not echo its
   * request keeps its exact result shape. Non-object and array results are returned unchanged.
   *
   * Bounds the `params` **on the result**, not the `params` argument passed to `process()` — those
   * are usually the same object, but when they differ the result's own value is the one that would
   * actually be sent, so that is the one to bound. Substituting the argument instead silently
   * replaced the result's payload with a different object.
   */
  private static withBoundedParams(result: any, budget: number): any {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
    if (!Object.prototype.hasOwnProperty.call(result, 'params')) return result;
    return { ...result, params: ToolResultProcessor.curateParams(result.params, budget) };
  }

  /**
   * Universal default max output character limit for tool responses.
   * Can be configured globally via REACTORY_TOOL_MAX_OUTPUT_SIZE environment variable.
   */
  public static getDefaultMaxOutputSize(): number {
    if (process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE) {
      const parsed = parseInt(process.env.REACTORY_TOOL_MAX_OUTPUT_SIZE, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 20000;
  }

  /**
   * Processes any tool execution result. If the stringified representation of the result
   * exceeds maxOutputSize, the full payload is saved to a file, and the returned object
   * or string is truncated and augmented with file details and AI guidance.
   */
  public static process(
    toolName: string,
    params: any,
    rawResult: any,
    state?: ChatState,
    context?: Reactory.Server.IReactoryContext,
    options?: ToolResultProcessorOptions
  ): ProcessedToolResult {
    if (rawResult === null || rawResult === undefined) {
      return { result: rawResult, outputTruncated: false };
    }

    // Redact credential material FIRST - before the payload is measured, before the
    // offload-to-file branch writes it to disk and before it is returned for the
    // conversation. Doing this after the offload branch (or not at all) turns a leak
    // into a persisted artefact in the agent workspace.
    //
    // Strings take the text path: a structural walk cannot see inside one, and a string
    // result is a documented shape here (graphql/data return JSON strings, shell returns
    // raw output). Both paths must be clean before the size check and the file write.
    rawResult = typeof rawResult === 'string'
      ? ToolResultProcessor.redactSensitiveText(rawResult)
      : ToolResultProcessor.redactSensitive(rawResult);

    const maxOutputSize = options?.maxOutputSize && options.maxOutputSize > 0
      ? options.maxOutputSize
      : ToolResultProcessor.getDefaultMaxOutputSize();

    const paramsBudget =
      options?.paramsBudget && options.paramsBudget > 0
        ? options.paramsBudget
        : options?.fieldBudget && options.fieldBudget > 0
          ? options.fieldBudget
          : ToolResultProcessor.DEFAULT_FIELD_BUDGET;

    // Convert result to string payload to measure size
    let payloadString = '';
    if (typeof rawResult === 'string') {
      payloadString = rawResult;
    } else {
      try {
        payloadString = JSON.stringify(rawResult, null, 2);
      } catch (err) {
        payloadString = String(rawResult);
      }
    }

    // If within safe size limits, return the result with its `params` bounded.
    if (payloadString.length <= maxOutputSize) {
      return {
        result: ToolResultProcessor.withBoundedParams(rawResult, paramsBudget),
        outputTruncated: false,
      };
    }

    // Determine target directory for file offloading
    let targetDir = options?.outputDir;
    if (!targetDir) {
      const userHome = (context as any)?.user?.home || (state?.context as any)?.user?.home;
      if (userHome && fs.existsSync(userHome)) {
        targetDir = path.join(userHome, 'workspace');
        if (!fs.existsSync(targetDir)) {
          try {
            fs.mkdirSync(targetDir, { recursive: true });
          } catch (e) {
            targetDir = os.tmpdir();
          }
        }
      } else {
        targetDir = os.tmpdir();
      }
    }

    const timestamp = Date.now();
    const prefix = options?.filePrefix || toolName || 'tool';
    const isJson = typeof rawResult !== 'string';
    const ext = isJson ? '.json' : '.log';
    const outputFile = path.join(targetDir, `${prefix}-output-${timestamp}${ext}`);
    const outputSize = Buffer.byteLength(payloadString, 'utf8');

    try {
      fs.writeFileSync(outputFile, payloadString, { encoding: 'utf8' });
      logger.info(`[ToolResultProcessor] Offloaded ${outputSize} bytes of output from tool '${toolName}' to ${outputFile}`);
    } catch (writeError: any) {
      logger.error(`[ToolResultProcessor] Failed to write output file ${outputFile}: ${writeError.message}`);
    }

    const noticeMessage = `Output size (${outputSize} bytes / ${payloadString.length} characters) exceeds maximum inline threshold (${maxOutputSize} characters). Full result saved to: ${outputFile}. Please use targeted search tools (such as snip, readFile, grep, searchContent, or sliceVariable) to inspect specific sections of the file, or refine your tool parameters/query to reduce output volume.`;
    const instructionsText = `Tool '${toolName}' produced large output (${outputSize} bytes). Complete payload saved to file: ${outputFile}. Use targeted inspection tools (e.g. snip, readFile, grep) to inspect specific sections or refine parameters to reduce output size.`;

    let processedResult: any;

    if (typeof rawResult === 'string') {
      processedResult = noticeMessage;
    } else if (typeof rawResult === 'object') {
      // Clone result to avoid mutating caller object unexpectedly
      processedResult = Array.isArray(rawResult) ? [...rawResult] : { ...rawResult };

      if (processedResult.data !== undefined) {
        // Structured macro result
        if (typeof processedResult.data === 'object' && processedResult.data !== null) {
          processedResult.data = ToolResultProcessor.curateDataObject(
            processedResult.data,
            noticeMessage,
            options?.fieldBudget
          );
          processedResult.data.outputFile = outputFile;
          processedResult.data.outputSize = outputSize;
          processedResult.data.outputTruncated = true;
          processedResult.data.summary = noticeMessage;
        } else if (typeof processedResult.data === 'string') {
          processedResult.data = noticeMessage;
        }

        processedResult.instructions = processedResult.instructions
          ? `${processedResult.instructions}\n\n${instructionsText}`
          : instructionsText;

        processedResult.params = ToolResultProcessor.curateParams(processedResult.params, paramsBudget);
      } else {
        // Plain object or array payload
        processedResult = {
          outputTruncated: true,
          outputFile,
          outputSize,
          message: noticeMessage,
          instructions: instructionsText,
          tool: toolName,
          // `params` may be the caller's own object rather than the one on the result,
          // so it is redacted on its way in as well.
          params: ToolResultProcessor.curateParams(
            ToolResultProcessor.redactSensitive(params),
            paramsBudget
          )
        };
      }
    } else {
      processedResult = noticeMessage;
    }

    return {
      result: processedResult,
      outputTruncated: true,
      outputFile,
      outputSize,
    };
  }
}

export default ToolResultProcessor;
