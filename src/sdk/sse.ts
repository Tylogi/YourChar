import { YourCharAbortError, YourCharProtocolError } from "./errors.js";
import type { SessionMessageResponse, SessionStreamEvent } from "./types.js";

const maximumBufferedEventCharacters = 4 * 1024 * 1024;

export async function* parseSessionEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SessionStreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new YourCharAbortError({ cause: signal.reason });
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw new YourCharAbortError({ cause: error });
        }
        throw error;
      }
      buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
      if (buffer.length > maximumBufferedEventCharacters) {
        throw new YourCharProtocolError("headless event exceeded the SDK buffer limit");
      }
      buffer = buffer.replace(/\r\n/gu, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (read.done) break;
    }
    if (buffer.trim()) {
      const event = parseFrame(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSessionStreamEvent(value: unknown): SessionStreamEvent {
  const event = record(value, "stream event");
  const type = stringField(event, "type");
  if (type === "delta") {
    return { type, delta: stringField(event, "delta") };
  }
  if (type === "reasoning_status") {
    const phase = stringField(event, "phase");
    if (phase !== "start" && phase !== "end") invalid("reasoning_status.phase");
    return { type, phase };
  }
  if (type === "tool_start") {
    return {
      type,
      toolName: stringField(event, "toolName"),
      toolCallId: stringField(event, "toolCallId"),
    };
  }
  if (type === "tool_end") {
    return {
      type,
      toolName: stringField(event, "toolName"),
      toolCallId: stringField(event, "toolCallId"),
      isError: booleanField(event, "isError"),
      result: event.result,
    };
  }
  if (type === "auto_retry_start" || type === "auto_retry_end") {
    return { ...event, type };
  }
  if (type === "lifecycle") {
    return { type, eventType: stringField(event, "eventType") };
  }
  if (type === "done") {
    return { type, response: messageResponse(event.response) };
  }
  if (type === "error") {
    return { type, error: stringField(event, "error") };
  }
  throw new YourCharProtocolError(`unsupported headless stream event type: ${type}`);
}

function parseFrame(frame: string): SessionStreamEvent | undefined {
  const data = frame.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""))
    .join("\n");
  if (!data) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new YourCharProtocolError("headless stream returned invalid JSON", { cause: error });
  }
  return parseSessionStreamEvent(value);
}

function messageResponse(value: unknown): SessionMessageResponse {
  const response = record(value, "done.response");
  const status = stringField(response, "status");
  if (!new Set(["completed", "failed", "cancelled", "blocked"]).has(status)) {
    invalid("done.response.status");
  }
  const messageType = stringField(response, "messageType");
  if (messageType !== "assistant" && messageType !== "system") {
    invalid("done.response.messageType");
  }
  if (!Array.isArray(response.actions) || !Array.isArray(response.events)) {
    invalid("done.response actions/events");
  }
  stringField(response, "reply");
  stringField(response, "sessionId");
  booleanField(response, "canRetry");
  return response as SessionMessageResponse;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function stringField(recordValue: Record<string, unknown>, field: string): string {
  const value = recordValue[field];
  if (typeof value !== "string") invalid(field);
  return value;
}

function booleanField(recordValue: Record<string, unknown>, field: string): boolean {
  const value = recordValue[field];
  if (typeof value !== "boolean") invalid(field);
  return value;
}

function invalid(field: string): never {
  throw new YourCharProtocolError(`invalid headless stream field: ${field}`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
