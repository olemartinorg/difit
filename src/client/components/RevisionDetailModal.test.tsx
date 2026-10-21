import { fireEvent, render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';

import { validateDiffArguments } from '../../cli/utils';
import type { DiffSelection, RevisionsResponse } from '../../types/diff';

import { RevisionDetailModal } from './RevisionDetailModal';

const options: RevisionsResponse = {
  specialOptions: [
    { value: '.', label: 'All Uncommitted Changes' },
    { value: 'staged', label: 'Staging Area' },
    { value: 'working', label: 'Working Directory' },
  ],
  branches: [{ name: 'main', current: true }],
  commits: [{ hash: 'abc1234', shortHash: 'abc1234', message: 'Commit A' }],
};

function choose(label: 'Base' | 'Target', value: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}:`) }));
  fireEvent.click(screen.getByRole('button', { name: value }));
}

describe('RevisionDetailModal', () => {
  it.each([
    {
      initial: { baseCommitish: 'abc1234', targetCommitish: '.' },
      first: ['Target', 'Working Directory'],
      second: ['Base', 'Staging Area'],
      expected: { baseCommitish: 'staged', targetCommitish: 'working' },
    },
    {
      initial: { baseCommitish: 'abc1234', targetCommitish: '.' },
      first: ['Base', 'Staging Area'],
      second: ['Target', 'Working Directory'],
      expected: { baseCommitish: 'staged', targetCommitish: 'working' },
    },
    {
      initial: { baseCommitish: 'staged', targetCommitish: 'working' },
      first: ['Base', 'abc1234 Commit A'],
      second: ['Target', 'All Uncommitted Changes'],
      expected: { baseCommitish: 'abc1234', targetCommitish: '.' },
    },
    {
      initial: { baseCommitish: 'staged', targetCommitish: 'working' },
      first: ['Target', 'All Uncommitted Changes'],
      second: ['Base', 'abc1234 Commit A'],
      expected: { baseCommitish: 'abc1234', targetCommitish: '.' },
    },
  ])(
    'keeps the active review until a supported pair is selected: $first',
    ({ initial, first, second, expected }) => {
      const onApply = vi.fn();
      const onClose = vi.fn();
      render(
        <HotkeysProvider>
          <RevisionDetailModal
            isOpen
            onClose={onClose}
            options={options}
            selection={initial}
            onApply={onApply}
          />
        </HotkeysProvider>,
      );

      choose(first[0] as 'Base' | 'Target', first[1]!);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      choose(second[0] as 'Base' | 'Target', second[1]!);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(expected);
      expect(onClose).toHaveBeenCalledOnce();
      expect(validateDiffArguments(expected.targetCommitish, expected.baseCommitish).valid).toBe(
        true,
      );
    },
  );

  it.each<DiffSelection>([
    { baseCommitish: '.', targetCommitish: 'working' },
    { baseCommitish: 'working', targetCommitish: '.' },
    { baseCommitish: 'abc1234', targetCommitish: 'abc1234' },
  ])('blocks unsupported initial selections: $baseCommitish / $targetCommitish', (selection) => {
    const onApply = vi.fn();
    render(
      <HotkeysProvider>
        <RevisionDetailModal
          isOpen
          onClose={vi.fn()}
          options={options}
          selection={selection}
          onApply={onApply}
        />
      </HotkeysProvider>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clears hidden merge-base state when applying', () => {
    const onApply = vi.fn();

    render(
      <HotkeysProvider>
        <RevisionDetailModal
          isOpen
          onClose={vi.fn()}
          options={{
            specialOptions: [
              { value: '.', label: 'All Uncommitted Changes' },
              { value: 'staged', label: 'Staging Area' },
              { value: 'working', label: 'Working Directory' },
            ],
            branches: [{ name: 'main', current: true }],
            commits: [{ hash: 'abc1234', shortHash: 'abc1234', message: 'Commit A' }],
          }}
          selection={{
            baseCommitish: 'origin/main',
            targetCommitish: '.',
            baseMode: 'merge-base',
          }}
          onApply={onApply}
        />
      </HotkeysProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onApply).toHaveBeenCalledWith({
      baseCommitish: 'origin/main',
      targetCommitish: '.',
    });
  });
});
