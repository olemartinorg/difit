import type { Express } from 'express';

import type { DiffSelection } from '../types/diff.js';
import { getEmptyReviewSelection } from '../utils/reviewSelection.js';
import type { ReviewDiffParser } from './review-diff.js';
import { ReviewInventoryService } from './review-inventory.js';
import { readUserConfig, updateUserClientSettings } from './user-config.js';

export class ReviewApi {
  private readonly inventory;

  constructor(
    repositoryPath: string,
    private readonly repositoryId: string,
    private readonly parser: ReviewDiffParser,
    private readonly reviewByDefault: boolean,
    private readonly importedDiff: boolean,
  ) {
    this.inventory = new ReviewInventoryService(repositoryPath, parser);
  }

  private async getInventory(target?: string) {
    const config = await readUserConfig();
    const targets = config.client.reviewTargets as Record<string, string> | undefined;
    const inventory = await this.inventory.getInventory(target ?? targets?.[this.repositoryId]);
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
        const inventory = await this.inventory.getInventory(body.target);
        if (inventory.target !== body.target)
          throw new Error(`Target branch does not exist: ${body.target}`);
        const config = await readUserConfig();
        const targets = config.client.reviewTargets as Record<string, string> | undefined;
        await updateUserClientSettings({
          reviewTargets: { ...targets, [this.repositoryId]: body.target },
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
          await this.parser.getReviewStats({
            baseCommitish: req.query.base,
            targetCommitish: req.query.target,
            includeUntracked: req.query.includeUntracked === 'true',
          }),
        );
      } catch (error) {
        res
          .status(400)
          .json({ error: error instanceof Error ? error.message : 'Could not load statistics' });
      }
    });
  }
}
