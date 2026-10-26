import { assertReviewCheckout } from './review-identity.js';
import type { Express } from 'express';

import type { DiffSelection } from '../types/diff.js';
import { getEmptyReviewSelection } from '../utils/reviewSelection.js';
import type { ReviewDiffParser } from './review-diff.js';
import type { ReviewSubject } from '../types/reviewSubmission.js';
import { ReviewInventoryService } from './review-inventory.js';
import { readUserConfig, updateUserClientSettings } from './user-config.js';

export class ReviewApi {
  private readonly inventory;

  constructor(
    private readonly repositoryPath: string,
    private readonly repositoryId: string,
    private readonly parser: ReviewDiffParser,
    private readonly reviewByDefault: boolean,
    private readonly importedDiff: boolean,
    private readonly reviewedBranch?: string,
  ) {
    this.inventory = new ReviewInventoryService(repositoryPath, parser);
  }

  private async getInventory(
    target?: string,
    ignoreWhitespace = false,
    reviewedBranch = this.reviewedBranch,
    subject?: ReviewSubject,
  ) {
    const config = await readUserConfig();
    const targets = config.client.reviewTargets as Record<string, string> | undefined;
    const contextKey = `${this.repositoryId}:${reviewedBranch ?? 'HEAD'}${subject?.pullRequest ? `:${subject.sourceRepository ?? ''}:${subject.head}:${subject.pullRequest.url}:${subject.pullRequest.baseHead ?? subject.pullRequest.base}` : ''}`;
    const savedTarget = targets?.[contextKey];
    const capturedBase = subject?.pullRequest?.baseHead ?? subject?.baseHead ?? subject?.base;
    const selectedTarget = target ?? savedTarget ?? capturedBase;
    await assertReviewCheckout(this.repositoryPath, subject);
    const inventory = await this.inventory.getInventory(
      selectedTarget,
      ignoreWhitespace,
      reviewedBranch,
      subject?.head,
      Boolean(subject?.checkout),
      Boolean(subject?.pullRequest) || !subject?.checkout,
      subject?.pullRequest
        ? { head: subject.pullRequest.head, source: subject.sourceRepository ?? '' }
        : undefined,
    );
    await assertReviewCheckout(this.repositoryPath, subject);
    if (selectedTarget && inventory.target === selectedTarget) {
      inventory.baseSuggestion = {
        ref: selectedTarget,
        reason: target
          ? 'Selected comparison base'
          : savedTarget
            ? 'Saved comparison base for this branch'
            : subject?.pullRequest
              ? `Pull request target: ${subject.pullRequest.base}`
              : 'Comparison base captured for this review',
        ambiguous: false,
        candidates: [selectedTarget],
      };
    }
    const pullRequest = subject?.pullRequest;
    if (
      pullRequest?.baseHead &&
      !inventory.targetOptions.some((option) => option.name === pullRequest.baseHead)
    ) {
      inventory.targetOptions.unshift({
        name: pullRequest.baseHead,
        label: `${pullRequest.base} (${pullRequest.baseHead.slice(0, 7)})`,
        kind: 'remote',
      });
    }
    inventory.reviewByDefault = this.reviewByDefault;
    return inventory;
  }

  async initialSelection(fallback: DiffSelection): Promise<DiffSelection> {
    if (!this.reviewByDefault || this.importedDiff) return fallback;
    const inventory = await this.getInventory();
    return inventory.defaultSelection ?? getEmptyReviewSelection(inventory.head);
  }

  registerRoutes(app: Express, onTargetChange: () => void) {
    app.get('/api/review', async (req, res) => {
      if (this.importedDiff) {
        res.status(400).json({ error: 'Change selection is not available for imported diffs' });
        return;
      }
      try {
        const inventory = await this.getInventory(
          typeof req.query.target === 'string' ? req.query.target : undefined,
          req.query.ignoreWhitespace === 'true',
          typeof req.query.reviewBranch === 'string' ? req.query.reviewBranch : undefined,
          typeof req.query.reviewSubject === 'string'
            ? (JSON.parse(req.query.reviewSubject) as ReviewSubject)
            : undefined,
        );
        res.json(inventory);
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Could not load changes' });
      }
    });

    app.put('/api/review/target', async (req, res) => {
      const body = req.body as { target?: unknown } | undefined;
      if (this.importedDiff || typeof body?.target !== 'string') {
        res.status(400).json({ error: 'A target branch is required' });
        return;
      }
      try {
        const branch =
          typeof req.query.reviewBranch === 'string' ? req.query.reviewBranch : this.reviewedBranch;
        const subject =
          typeof req.query.reviewSubject === 'string'
            ? (JSON.parse(req.query.reviewSubject) as ReviewSubject)
            : undefined;
        const inventory = await this.inventory.getInventory(
          body.target,
          false,
          branch,
          subject?.head,
          Boolean(subject?.checkout),
          Boolean(subject?.pullRequest) || !subject?.checkout,
        );
        if (inventory.target !== body.target)
          throw new Error(`Target branch does not exist: ${body.target}`);
        const config = await readUserConfig();
        const targets = config.client.reviewTargets as Record<string, string> | undefined;
        await updateUserClientSettings({
          reviewTargets: {
            ...targets,
            [`${this.repositoryId}:${branch ?? 'HEAD'}${subject?.pullRequest ? `:${subject.sourceRepository ?? ''}:${subject.head}:${subject.pullRequest.url}:${subject.pullRequest.baseHead ?? subject.pullRequest.base}` : ''}`]:
              body.target,
          },
        });
        onTargetChange();
        res.json({ ok: true });
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Could not save target' });
      }
    });

    app.get('/api/review/stats', async (req, res) => {
      if (
        this.importedDiff ||
        typeof req.query.base !== 'string' ||
        typeof req.query.target !== 'string'
      ) {
        res.status(400).json({ error: 'A base and target are required' });
        return;
      }
      try {
        res.json(
          await this.parser.getReviewStats(
            {
              baseCommitish: req.query.base,
              targetCommitish: req.query.target,
              includeUntracked: req.query.includeUntracked === 'true',
            },
            req.query.ignoreWhitespace === 'true',
          ),
        );
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Could not load statistics' });
      }
    });
  }
}
