import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewTargetPicker } from './ReviewTargetPicker';

afterEach(cleanup);

it('displays and searches the captured PR target by branch while retaining its exact OID value', () => {
  const head = 'a'.repeat(40),
    changed = vi.fn();
  render(
    <ReviewTargetPicker
      targets={[
        { name: head, label: 'release/2026 (aaaaaaa)', kind: 'remote' },
        { name: 'origin/trunk', kind: 'remote' },
      ]}
      target={head}
      disabled={false}
      onChange={changed}
    />,
  );
  expect(screen.getByRole('button', { name: 'Target branch' }).textContent).toContain(
    'release/2026 (aaaaaaa)',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Target branch' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search target branches' }), {
    target: { value: 'release/2026' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'release/2026 (aaaaaaa)' }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(head);
});
