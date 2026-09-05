import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LogSink } from '@pomni/core';

/**
 * Streams a run's combined output to its own log file.
 *
 * The file is the durable copy — the in-memory buffer the analyzer sees is capped, and the
 * SSE log endpoint reads this file rather than subscribing to the bus, so a run started in
 * another process can still be followed.
 */
export class FileLogSink implements LogSink {
  private readonly streams = new Map<string, WriteStream>();

  async open(runId: string, absPath: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    this.streams.set(runId, createWriteStream(absPath, { flags: 'a' }));
  }

  write(runId: string, chunk: string): void {
    this.streams.get(runId)?.write(chunk);
  }

  async close(runId: string): Promise<void> {
    const stream = this.streams.get(runId);
    if (!stream) return;
    this.streams.delete(runId);
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

export interface LogChunk {
  text: string;
  offset: number;
}

/** Read a log from `offset`, for both the initial replay and each poll of a live tail. */
export async function readLogFrom(path: string, offset: number): Promise<LogChunk> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: '', offset };
  }

  // Truncated or rotated underneath us: start over rather than serving garbage.
  if (size < offset) return { text: '', offset: size };
  if (size === offset) return { text: '', offset };

  const handle = await open(path, 'r');
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return { text: buffer.toString('utf8'), offset: size };
  } finally {
    await handle.close();
  }
}
