import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonObject, JsonValue } from "@replicantos/protocol";

import { deferred, type Deferred } from "./deferred.js";
import { asJsonObject, record, string } from "./json.js";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcNotification {
  method: string;
  params?: JsonObject;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface JsonRpcPeer {
  request<T extends JsonValue = JsonObject>(
    method: string,
    params?: JsonObject,
    timeoutMs?: number,
  ): Promise<T>;
  notify(method: string, params?: JsonObject): void;
  close(): void;
  readonly closed: Promise<ProcessExit>;
}

export interface JsonRpcPeerCallbacks {
  onNotification?(notification: JsonRpcNotification): Promise<void> | void;
  onRequest?(request: JsonRpcRequest): Promise<JsonValue> | JsonValue;
  onProtocolError?(error: Error): void;
  onStderr?(message: string): void;
}

export interface JsonRpcPeerSpec extends JsonRpcPeerCallbacks {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  includeJsonRpcHeader: boolean;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

export type JsonRpcPeerFactory = (spec: JsonRpcPeerSpec) => JsonRpcPeer;

interface PendingRequest {
  deferred: Deferred<JsonValue>;
  timer: NodeJS.Timeout;
  method: string;
}

export class JsonLineDecoder {
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(maxLineBytes = 1024 * 1024) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: string): string[] {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#buffer = "";
      throw new Error("JSON-RPC line exceeded the configured size limit.");
    }
    const parts = this.#buffer.split(/\r?\n/);
    this.#buffer = parts.pop() ?? "";
    return parts.filter((line) => line.trim().length > 0);
  }
}

export class ProcessJsonRpcPeer implements JsonRpcPeer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #callbacks: JsonRpcPeerCallbacks;
  readonly #includeHeader: boolean;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #decoder: JsonLineDecoder;
  readonly #closed = deferred<ProcessExit>();
  #nextId = 1;
  #expectedClose = false;

  constructor(spec: JsonRpcPeerSpec) {
    this.#callbacks = spec;
    this.#includeHeader = spec.includeJsonRpcHeader;
    this.#defaultTimeoutMs = spec.requestTimeoutMs ?? 30_000;
    this.#decoder = new JsonLineDecoder(spec.maxLineBytes);
    this.#child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#callbacks.onStderr?.(
        chunk.replace(/\s+/g, " ").trim().slice(0, 300),
      );
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      const exit = { code, signal, expected: this.#expectedClose };
      this.#closed.resolve(exit);
      this.#rejectPending(new Error("The harness transport closed."));
    });
  }

  get closed(): Promise<ProcessExit> {
    return this.#closed.promise;
  }

  request<T extends JsonValue = JsonObject>(
    method: string,
    params: JsonObject = {},
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<T> {
    const id = this.#nextId++;
    const pending = deferred<JsonValue>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      pending.reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    timer.unref();
    this.#pending.set(id, { deferred: pending, timer, method });
    this.#write({ id, method, params });
    return pending.promise as Promise<T>;
  }

  notify(method: string, params: JsonObject = {}): void {
    this.#write({ method, params });
  }

  close(): void {
    if (this.#expectedClose) return;
    this.#expectedClose = true;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
  }

  #write(message: Record<string, unknown>): void {
    const wire = this.#includeHeader ? { jsonrpc: "2.0", ...message } : message;
    this.#child.stdin.write(`${JSON.stringify(wire)}\n`);
  }

  #consume(chunk: string): void {
    try {
      for (const line of this.#decoder.push(chunk)) this.#consumeLine(line);
    } catch (error) {
      this.#fail(
        error instanceof Error ? error : new Error("Invalid JSON-RPC stream."),
      );
    }
  }

  #consumeLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Harness emitted malformed JSON-RPC.");
    }
    const message = record(value);
    if (!message)
      throw new Error("Harness emitted a non-object JSON-RPC message.");
    const method = string(message.method);
    const id =
      typeof message.id === "number" || typeof message.id === "string"
        ? message.id
        : undefined;
    if (method && id !== undefined) {
      const request: JsonRpcRequest = {
        id,
        method,
        ...(message.params === undefined
          ? {}
          : { params: asJsonObject(message.params) ?? {} }),
      };
      void this.#answerRequest(request);
      return;
    }
    if (method) {
      const notification: JsonRpcNotification = {
        method,
        ...(message.params === undefined
          ? {}
          : { params: asJsonObject(message.params) ?? {} }),
      };
      void Promise.resolve(
        this.#callbacks.onNotification?.(notification),
      ).catch((error) => {
        this.#fail(
          error instanceof Error
            ? error
            : new Error("Notification handler failed."),
        );
      });
      return;
    }
    if (id === undefined)
      throw new Error("Harness emitted an unrecognized JSON-RPC message.");
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const rpcError = record(message.error);
    if (rpcError) {
      pending.deferred.reject(
        new Error(
          string(rpcError.message) ?? `${pending.method} returned an error.`,
        ),
      );
      return;
    }
    pending.deferred.resolve((message.result ?? {}) as JsonValue);
  }

  async #answerRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.#callbacks.onRequest) {
      this.#write({
        id: request.id,
        error: { code: -32601, message: "Method not supported" },
      });
      return;
    }
    try {
      const result = await this.#callbacks.onRequest(request);
      this.#write({ id: request.id, result });
    } catch (error) {
      this.#write({
        id: request.id,
        error: {
          code: -32000,
          message:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "Request failed",
        },
      });
    }
  }

  #fail(error: Error): void {
    this.#callbacks.onProtocolError?.(error);
    this.#rejectPending(error);
    this.close();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.deferred.reject(error);
    }
    this.#pending.clear();
  }
}

export const createProcessJsonRpcPeer: JsonRpcPeerFactory = (spec) =>
  new ProcessJsonRpcPeer(spec);
