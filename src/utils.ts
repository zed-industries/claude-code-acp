// A pushable async iterable: allows you to push items and consume them with for-await.

import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

// Useful for bridging push-based and async-iterator-based code.
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

export function unreachable(value: never): never {
  throw new Error(`Unexpected case: ${value}`);
}

export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time));
}

interface ManagedSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  env?: Record<string, string>;
}

// Following the rules in https://docs.anthropic.com/en/docs/claude-code/settings#settings-files
// This can be removed once the SDK supports it natively.
function getManagedSettingsPath(): string {
  const os = platform();
  switch (os) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "linux": // including WSL
      return "/etc/claude-code/managed-settings.json";
    case "win32":
      return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

export function loadManagedSettings(): ManagedSettings | null {
  try {
    return JSON.parse(readFileSync(getManagedSettingsPath(), "utf8")) as ManagedSettings;
  } catch {
    return null;
  }
}

export function applyEnvironmentSettings(settings: ManagedSettings): void {
  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      process.env[key] = value;
    }
  }
}

export interface ExtractLinesResult {
  content: string;
  actualEndLine: number;
  wasLimited: boolean;
  linesRead: number;
  bytesRead: number;
  totalLines: number;
}

/**
 * Extracts lines from file content with byte limit enforcement.
 *
 * @param fullContent - The complete file content
 * @param offset - Starting line number (0-based)
 * @param limit - Maximum number of lines to read
 * @param maxBytes - Maximum bytes to return (default 50000)
 * @returns Object containing extracted content and metadata
 */
export function extractLinesWithByteLimit(
  fullContent: string,
  offset: number = 0,
  limit: number = 1000,
  maxBytes: number = 50000,
): ExtractLinesResult {
  const allLines = fullContent.split("\n");
  const totalLines = allLines.length;

  // Validate offset
  if (offset >= totalLines) {
    return {
      content: "",
      actualEndLine: offset,
      wasLimited: false,
      linesRead: 0,
      bytesRead: 0,
      totalLines,
    };
  }

  // Handle special case of 0 byte limit
  if (maxBytes === 0) {
    return {
      content: "",
      actualEndLine: offset,
      wasLimited: false,
      linesRead: 0,
      bytesRead: 0,
      totalLines,
    };
  }

  // Extract the requested lines, but respect byte limit
  const requestedEndLine = Math.min(offset + limit, totalLines);

  let extractedLines: string[] = [];
  let currentSize = 0;
  let actualEndLine = offset;

  for (let i = offset; i < requestedEndLine; i++) {
    const lineWithNewline = allLines[i] + (i < requestedEndLine - 1 ? "\n" : "");
    const lineBytes = Buffer.from(lineWithNewline).length;

    if (currentSize + lineBytes > maxBytes && extractedLines.length > 0) {
      // Would exceed maxBytes, stop here
      break;
    }

    extractedLines.push(allLines[i]);
    currentSize += lineBytes;
    actualEndLine = i + 1;
  }

  const extractedContent = extractedLines.join("\n");
  const wasLimited = actualEndLine < requestedEndLine;
  const linesRead = actualEndLine - offset;

  return {
    content: extractedContent,
    actualEndLine,
    wasLimited,
    linesRead,
    bytesRead: currentSize,
    totalLines,
  };
}
