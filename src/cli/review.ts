import { createConnection } from 'node:net';
import { ReviewInventoryService } from '../server/review-inventory.js';
import { Command, Option } from 'commander';

import type { ReviewSubmission } from '../types/reviewSubmission.js';

export function createReviewCommand(): Command {
  const review = new Command('review').description('Receive an explicitly submitted review');
  const querySubmitted = (repository: string, id?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = createConnection('/run/sandbox-github/hint.sock');
      let data = '';
      socket.setTimeout(10000, () => socket.destroy(new Error('Submitted review query timed out')));
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(
          JSON.stringify({ kind: 'submitted-reviews', repository, ...(id ? { id } : {}) }) + '\n',
        ),
      );
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('end', () => {
        try {
          const payload = JSON.parse(data) as { result?: unknown; error?: string };
          if (payload.error) reject(new Error(payload.error));
          else resolve(payload.result);
        } catch (error) {
          reject(error);
        }
      });
    });
  review
    .command('list')
    .description('List submitted feedback for this task repository, without opening a view')
    .requiredOption('--repository <name>', 'task repository name')
    .action(async (options: { repository: string }) => {
      try {
        console.log(JSON.stringify(await querySubmitted(options.repository)));
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
    });
  review
    .command('get')
    .description('Retrieve an immutable submitted review and its delivery receipt')
    .argument('<id>', 'submission ID')
    .requiredOption('--repository <name>', 'task repository name')
    .action(async (id: string, options: { repository: string }) => {
      try {
        console.log(JSON.stringify(await querySubmitted(options.repository, id)));
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
    });
  review
    .command('inventory')
    .description('Inspect a branch without checkout')
    .option('--branch <name>', 'reviewed branch name')
    .option('--head <oid>', 'immutable reviewed commit')
    .option('--base <ref>', 'explicit comparison base')
    .action(async (options: { branch?: string; head?: string; base?: string }) => {
      try {
        console.log(
          JSON.stringify(
            await new ReviewInventoryService(process.cwd()).getInventory(
              options.base,
              false,
              options.branch,
              options.head,
            ),
          ),
        );
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
    });
  review
    .command('wait')
    .description('Wait for Pass review to agent, write one review to stdout, and exit')
    .requiredOption('--port <port>', 'port of the running difit server', (value) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      return port;
    })
    .addOption(
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('json'),
    )
    .action(async (options: { port: number; format: string }) => {
      const url = `http://localhost:${options.port}/api/review-handoff`;
      try {
        let response: Response;
        do {
          response = await fetch(url);
        } while (response.status === 204);
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string };
          throw new Error(payload.error ?? 'Could not receive the review');
        }
        const submission = (await response.json()) as ReviewSubmission;
        const output = options.format === 'text' ? submission.text : JSON.stringify(submission);
        await new Promise<void>((resolve, reject) => {
          process.stdout.once('error', reject);
          process.stdout.write(`${output}\n`, (error) => {
            process.stdout.removeListener('error', reject);
            if (error) reject(error);
            else resolve();
          });
        });
        const ack = await fetch(`${url}/${encodeURIComponent(submission.id)}/ack`, {
          method: 'POST',
        });
        if (!ack.ok) throw new Error('Review was written, but delivery could not be acknowledged.');
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : 'Could not receive the review'}`,
        );
        process.exitCode = 1;
      }
    });
  return review;
}
