import { Command, Option } from 'commander';

import type { ReviewSubmission } from '../types/reviewSubmission.js';

export function createReviewCommand(): Command {
  const review = new Command('review').description('Receive an explicitly submitted review');
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
