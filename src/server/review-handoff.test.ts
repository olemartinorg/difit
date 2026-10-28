import express from 'express';
import { fetch } from 'undici';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { registerReviewHandoff } from './review-handoff.js';

it.each([false, true])(
  'keeps one accepted handoff until receiver ACK, submitting connection lost=%s',
  async (lost) => {
    const app = express();
    app.use(express.json());
    let captureComplete!: () => void;
    const captured = new Promise<void>((resolve) => {
      captureComplete = resolve;
    });
    let captures = 0;
    registerReviewHandoff(app, {
      enabled: true,
      repositoryId: 'repo',
      parseThreads: () => [],
      capture: async (_request, body) => {
        captures++;
        captureComplete();
        return body;
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = {
      id: 'original-review',
      text: 'accepted text',
      commit: 'a',
      diffHash: 'b',
      threads: [],
      selection: { baseCommitish: 'a', targetCommitish: 'b' },
      resolvedSelection: { baseCommitish: 'a', targetCommitish: 'b' },
    };
    const post = request(`${origin}/api/review-handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    post.on('error', () => {});
    const response = new Promise<number>((resolve) => {
      post.on('response', (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode!);
      });
      post.on('error', () => resolve(0));
    });
    post.end(JSON.stringify(body));
    try {
      await captured;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (lost) {
        post.destroy();
        await response;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(121_000);
      vi.useRealTimers();
      const delivered = await (await fetch(`${origin}/api/review-handoff`)).json();
      expect(delivered).toMatchObject(body);
      const duplicate = await fetch(`${origin}/api/review-handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, id: 'second' }),
      });
      expect(duplicate.status).toBe(409);
      expect(
        (await fetch(`${origin}/api/review-handoff/original-review/ack`, { method: 'POST' }))
          .status,
      ).toBe(200);
      expect(
        (await fetch(`${origin}/api/review-handoff/original-review/ack`, { method: 'POST' }))
          .status,
      ).toBe(200);
      if (!lost) expect(await response).toBe(200);
      expect(captures).toBe(1);
    } finally {
      vi.useRealTimers();
      post.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
