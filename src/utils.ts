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
}

/**
 * Extracts lines from file content with byte limit enforcement.
 *
 * @param fullContent - The complete file content
 * @param linesToSkip - Starting line number (0-based)
 * @param linesToRead - Maximum number of lines to read
 * @param maxContentLength - Maximum number of UTF-16 Code Units to return
 * @returns Object containing extracted content and metadata
 */
export function extractLinesWithByteLimit(
  fullContent: string,
  linesToSkip: number,
  linesToRead: number,
  maxContentLength: number,
): ExtractLinesResult {
  if (fullContent === "" || linesToRead === 0) {
    if (linesToSkip === 0 && linesToRead > 0) {
      return {
        content: "",
        actualEndLine: 0,
        wasLimited: false,
        linesRead: 1,
      };
    } else {
      return {
        content: "",
        actualEndLine: linesToSkip,
        wasLimited: false,
        linesRead: 0,
      };
    }
  }

  let linesSeen = 0;
  let index = 0;

  while (linesSeen < linesToSkip) {
    const nextIndex = fullContent.indexOf("\n", index);

    // There were not enough lines to skip.
    if (nextIndex < 0) {
      return {
        content: "",
        actualEndLine: linesToSkip,
        wasLimited: false,
        linesRead: 0,
      };
    }

    linesSeen += 1;
    index = nextIndex + 1;
  }

  // We've successfully skipped over all the lines we were supposed to.
  // Now we can actually start reading!
  const startIndex = index;
  linesSeen = 0;

  let contentLength = 0;
  let wasLimited = false;

  while (linesSeen < linesToRead) {
    const nextIndex = fullContent.indexOf("\n", index);

    if (nextIndex < 0) {
      // Last line in file (no trailing newline)
      const newContentLength = fullContent.length - startIndex;
      if (linesSeen > 0 && newContentLength > maxContentLength) {
        wasLimited = true;
        break;
      }
      linesSeen += 1;
      contentLength = newContentLength;
      break;
    } else {
      // Line with newline - include up to the newline
      const newContentLength = nextIndex + 1 - startIndex;
      if (linesSeen > 0 && newContentLength > maxContentLength) {
        wasLimited = true;
        break;
      }
      linesSeen += 1;
      contentLength = newContentLength;
      index = nextIndex + 1;
    }
  }

  // If we ended with a newline and we stopped due to byte limit or line limit (not end of file), remove the trailing newline
  if (contentLength > 0 && fullContent[startIndex + contentLength - 1] === "\n") {
    // Check if there's more content after our current position that we didn't read
    if (startIndex + contentLength < fullContent.length) {
      contentLength -= 1;
    }
  }

  return {
    content: fullContent.slice(startIndex, startIndex + contentLength),
    actualEndLine: linesSeen > 0 ? linesToSkip + linesSeen - 1 : linesToSkip,
    wasLimited,
    linesRead: linesSeen,
  };
}
