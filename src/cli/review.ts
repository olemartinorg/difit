import { readFileSync } from 'node:fs';
import { migrateBranchReviews } from '../server/review-migration.js';
import { createConnection } from 'node:net';
import { ReviewStore } from '../server/review-store.js';
import type { ReviewSummaryRequest } from '../server/review-inventory.js';
import { ReviewInventoryService } from '../server/review-inventory.js';
import { Command, Option } from 'commander';

import type { ReviewSubmission, SubmittedReviewSummary } from '../types/reviewSubmission.js';

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
  const query = async (
    options: { repository?: string; store?: string; owner?: string },
    id?: string,
  ) => {
    if (options.store || options.owner) {
      if (!options.store || !options.owner || options.repository)
        throw new Error('Offline queries require --store and --owner, without --repository');
      const records = new ReviewStore(options.store, options.owner).submitted(id);
      if (id) {
        const record = records[0];
        if (!record) throw new Error('Unknown submitted review');
        return record;
      }
      return records.map(
        ({
          id,
          reviewId,
          submittedAt,
          repositoryId,
          subject,
          receipt,
        }): SubmittedReviewSummary => ({
          id,
          reviewId,
          submittedAt,
          repositoryId,
          subject,
          receipt,
        }),
      );
    }
    if (!options.repository) throw new Error('Task queries require --repository');
    return querySubmitted(options.repository, id);
  };
  review
    .command('list')
    .description('List submitted feedback for this task repository, without opening a view')
    .option('--repository <name>', 'task repository name for the mounted bridge')
    .option('--store <directory>', 'read an owned native review store without a server')
    .option('--owner <identity>', 'required exact owner for an offline store')
    .action(async (options: { repository?: string; store?: string; owner?: string }) => {
      try {
        console.log(JSON.stringify(await query(options)));
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
    });
  review
    .command('get')
    .description('Retrieve an immutable submitted review and its delivery receipt')
    .argument('<id>', 'submission ID')
    .option('--repository <name>', 'task repository name for the mounted bridge')
    .option('--store <directory>', 'read an owned native review store without a server')
    .option('--owner <identity>', 'required exact owner for an offline store')
    .action(
      async (id: string, options: { repository?: string; store?: string; owner?: string }) => {
        try {
          console.log(JSON.stringify(await query(options, id)));
        } catch (error) {
          console.error(String(error));
          process.exitCode = 1;
        }
      },
    );
  review
    .command('pending-comments')
    .description('Count saved branch comments that have not been accepted by an agent')
    .requiredOption('--store <directory>', 'offline review directory')
    .requiredOption('--owner <identity>', 'exact verified storage owner')
    .action((options: { store: string; owner: string }) => {
      console.log(JSON.stringify(new ReviewStore(options.store, options.owner).pendingComments()));
    });
  review
    .command('inspect-branch-record')
    .description('Read an owned offline branch record, including unresolved historical notes')
    .argument('<id>', 'review record UUID')
    .requiredOption('--store <directory>', 'offline review directory')
    .requiredOption('--owner <identity>', 'exact verified storage owner')
    .action((id: string, options: { store: string; owner: string }) => {
      console.log(JSON.stringify(new ReviewStore(options.store, options.owner).get(id)));
    });
  review
    .command('migrate-branch-owners')
    .description('Convert an offline version 1 store with explicit per-review source assignments')
    .requiredOption('--store <directory>', 'offline review directory')
    .requiredOption('--owner <identity>', 'exact verified storage owner')
    .requiredOption(
      '--assignments <file>',
      'JSON object keyed by every review UUID, with a source assignment or null',
    )
    .action((options: { store: string; owner: string; assignments: string }) => {
      console.log(
        JSON.stringify(
          migrateBranchReviews(
            options.store,
            options.owner,
            JSON.parse(readFileSync(options.assignments, 'utf8')) as Parameters<
              typeof migrateBranchReviews
            >[2],
          ),
        ),
      );
    });
  review
    .command('inventory')
    .description('Inspect a branch without checkout')
    .option('--branch <name>', 'reviewed branch name')
    .option('--head <oid>', 'immutable reviewed commit')
    .option('--base <ref>', 'explicit comparison base')
    .option('--checkout', 'include edits from the admitted current checkout')
    .option('--summary-batch', 'read a bounded JSON array of captured summaries from stdin')
    .option('--summary', 'read authoritative branch counts without grouped diff statistics')
    .option('--published-head <oid>', 'verified PR publication commit')
    .option('--publication-source <repository>', 'verified PR source repository')
    .option(
      '--comparison-only',
      'resolve the comparison without reading diffs or commit statistics',
    )
    .action(
      async (options: {
        branch?: string;
        head?: string;
        base?: string;
        checkout?: boolean;
        comparisonOnly?: boolean;
        summary?: boolean;
        summaryBatch?: boolean;
        publishedHead?: string;
        publicationSource?: string;
      }) => {
        try {
          if (options.summaryBatch) {
            if (
              options.summary ||
              options.branch ||
              options.head ||
              options.base ||
              options.checkout ||
              options.comparisonOnly ||
              options.publishedHead ||
              options.publicationSource
            )
              throw new Error('Summary batch does not accept scalar comparison options');
            let input = '';
            process.stdin.setEncoding('utf8');
            for await (const chunk of process.stdin) {
              input += String(chunk);
              if (Buffer.byteLength(input) > 1024 * 1024)
                throw new Error('Summary batch input exceeds 1 MiB');
            }
            console.log(
              JSON.stringify(
                await new ReviewInventoryService(process.cwd()).getSummaryBatch(
                  JSON.parse(input) as ReviewSummaryRequest[],
                ),
              ),
            );
            return;
          }
          console.log(
            JSON.stringify(
              options.summary
                ? await new ReviewInventoryService(process.cwd()).getSummary(
                    options.base,
                    options.branch,
                    options.head,
                    options.checkout,
                    options.publishedHead
                      ? { head: options.publishedHead, source: options.publicationSource ?? '' }
                      : undefined,
                  )
                : options.comparisonOnly
                  ? await new ReviewInventoryService(process.cwd())
                      .getComparison(options.base, options.branch, options.head)
                      .then(({ head, branchBase, target, baseSuggestion }) => ({
                        head,
                        branchBase,
                        target,
                        baseSuggestion,
                      }))
                  : await new ReviewInventoryService(process.cwd()).getInventory(
                      options.base,
                      false,
                      options.branch,
                      options.head,
                      options.checkout,
                    ),
            ),
          );
        } catch (error) {
          console.error(String(error));
          process.exitCode = 1;
        }
      },
    );
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
