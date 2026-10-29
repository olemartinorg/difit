import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { DiffFile } from '../../types/diff';

import { ImageDiffViewer } from './ImageDiffViewer';
import type { DiffViewerBodyProps } from './types';

describe('ImageDiffViewer', () => {
  const baseProps: Omit<DiffViewerBodyProps, 'file'> = {
    threads: [],
    diffMode: 'unified',
    mergedChunks: [],
    isExpandLoading: false,
    expandHiddenLines: vi.fn().mockResolvedValue(undefined),
    expandAllBetweenChunks: vi.fn().mockResolvedValue(undefined),
    onAddComment: vi.fn().mockResolvedValue(undefined),
    onGenerateThreadPrompt: vi.fn(),
    onRemoveThread: vi.fn(),
    onReplyToThread: vi.fn().mockResolvedValue(undefined),
    onRemoveMessage: vi.fn(),
    onUpdateMessage: vi.fn(),
  };

  const renderViewer = (file: DiffFile, overrides: Partial<DiffViewerBodyProps> = {}) =>
    render(<ImageDiffViewer {...baseProps} file={file} {...overrides} />);

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as Window & { __DIFIT_STATIC_BLOB_URLS__?: Record<string, string> })
      .__DIFIT_STATIC_BLOB_URLS__;
    // Mock fetch to return a blob with size
    (global.fetch as any).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve({ size: 1024 }),
    });
  });

  it('binds both image requests to the displayed subject and each accepted blob identity', () => {
    const subject = {
      repository: 'repo',
      branch: 'feature',
      head: 'a'.repeat(40),
      checkout: { branch: 'feature', head: 'a'.repeat(40) },
    };
    const file: DiffFile = {
      path: 'new image.png',
      oldPath: 'old image.png',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      chunks: [],
      oldBlobId: 'b'.repeat(40),
      newBlobId: 'c'.repeat(40),
    };
    renderViewer(file, {
      baseCommitish: 'captured-base',
      targetCommitish: '.',
      reviewSubject: subject,
    });
    const images = screen.getAllByRole<HTMLImageElement>('img');
    for (const [index, blobId] of [file.oldBlobId, file.newBlobId].entries()) {
      const url = new URL(images[index]!.src);
      expect(JSON.parse(url.searchParams.get('reviewSubject')!)).toEqual(subject);
      expect(url.searchParams.get('blobId')).toBe(blobId);
      expect(url.pathname).toContain('image.png');
    }
    expect(new URL(images[1]!.src).searchParams.get('ref')).toBe('.');
  });

  it.each([
    { status: 'added', diffMode: 'unified' },
    { status: 'deleted', diffMode: 'unified' },
    { status: 'modified', diffMode: 'unified' },
    { status: 'modified', diffMode: 'split' },
    { status: 'renamed', diffMode: 'split' },
  ] as const)(
    'restores rejected $status images in $diffMode mode after accepted refresh',
    async ({ status, diffMode }) => {
      const subject = {
        repository: 'repo',
        branch: 'feature',
        head: 'a'.repeat(40),
        checkout: { branch: 'feature', head: 'a'.repeat(40) },
      };
      const file: DiffFile = {
        path: 'image.png',
        oldPath: status === 'renamed' ? 'old-image.png' : undefined,
        status,
        additions: 0,
        deletions: 0,
        chunks: [],
        oldBlobId: 'b'.repeat(40),
        newBlobId: 'c'.repeat(40),
      };
      const props = { ...baseProps, file, diffMode, reviewSubject: subject, targetCommitish: '.' };
      const view = render(<ImageDiffViewer {...props} />);
      const images = Array.from(view.container.querySelectorAll('img'));
      for (const image of images) {
        fireEvent.error(image);
        expect(image.style.display).toBe('none');
        expect(image.nextElementSibling).not.toHaveClass('hidden');
      }
      const acceptedSubject = {
        ...subject,
        head: 'd'.repeat(40),
        checkout: { ...subject.checkout, head: 'd'.repeat(40) },
      };
      view.rerender(<ImageDiffViewer {...props} reviewSubject={acceptedSubject} />);
      for (const [index, image] of images.entries()) {
        expect(view.container.querySelectorAll('img')[index]).toBe(image);
        expect(new URL(image.src).searchParams.get('reviewSubject')).toBe(
          JSON.stringify(acceptedSubject),
        );
        Object.defineProperty(image, 'naturalWidth', { value: 240, configurable: true });
        Object.defineProperty(image, 'naturalHeight', { value: 120, configurable: true });
        fireEvent.load(image);
        expect(image.style.display).toBe('');
        expect(image.nextElementSibling).toHaveClass('hidden');
      }
      await waitFor(() =>
        expect(screen.getAllByText(/W: 240px \| H: 120px/)).toHaveLength(images.length),
      );
      expect(fetch).toHaveBeenCalledTimes(images.length);
      for (const [input] of vi.mocked(fetch).mock.calls) {
        const url = new URL(String(input));
        expect(JSON.parse(url.searchParams.get('reviewSubject')!)).toEqual(acceptedSubject);
      }
    },
  );

  describe('File status handling', () => {
    it('renders deleted image correctly', () => {
      const deletedFile: DiffFile = {
        path: 'test.jpg',
        oldPath: 'test.jpg',
        status: 'deleted',
        additions: 0,
        deletions: 1,
        chunks: [],
      };

      renderViewer(deletedFile);

      expect(screen.getByText('Deleted Image')).toBeInTheDocument();
      expect(screen.getByText('Previous version:')).toBeInTheDocument();
      expect(screen.getByRole('img')).toHaveAttribute('src', '/api/blob/test.jpg?ref=HEAD%7E1');
    });

    it('renders added image correctly', () => {
      const addedFile: DiffFile = {
        path: 'test.jpg',
        status: 'added',
        additions: 1,
        deletions: 0,
        chunks: [],
      };

      renderViewer(addedFile);

      expect(screen.getByText('Added Image')).toBeInTheDocument();
      expect(screen.getByText('New file:')).toBeInTheDocument();
      expect(screen.getByRole('img')).toHaveAttribute('src', '/api/blob/test.jpg?ref=HEAD');
    });

    it('renders modified image correctly in split mode', () => {
      const modifiedFile: DiffFile = {
        path: 'test.jpg',
        oldPath: 'test.jpg',
        status: 'modified',
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      renderViewer(modifiedFile, { diffMode: 'split' });

      expect(screen.getByText('Modified Image')).toBeInTheDocument();
      expect(screen.getByText('Previous version:')).toBeInTheDocument();
      expect(screen.getByText('Current version:')).toBeInTheDocument();

      const images = screen.getAllByRole('img');
      expect(images).toHaveLength(2);
    });

    it('handles renamed image correctly', () => {
      const renamedFile: DiffFile = {
        path: 'new-name.jpg',
        oldPath: 'old-name.jpg',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        chunks: [],
      };

      renderViewer(renamedFile);

      expect(screen.getByText('Modified Image')).toBeInTheDocument();

      const images = screen.getAllByRole('img');
      expect(images[0]).toHaveAttribute('src', '/api/blob/old-name.jpg?ref=HEAD%7E1');
      expect(images[1]).toHaveAttribute('src', '/api/blob/new-name.jpg?ref=HEAD');
    });
  });

  describe('Image loading with custom refs', () => {
    it('sets correct image src URLs with custom commitish', () => {
      const file: DiffFile = {
        path: 'test.jpg',
        oldPath: 'old-test.jpg',
        status: 'modified',
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      renderViewer(file, { baseCommitish: 'main', targetCommitish: 'feature' });

      const images = screen.getAllByRole('img');
      expect(images[0]).toHaveAttribute('src', '/api/blob/old-test.jpg?ref=main');
      expect(images[1]).toHaveAttribute('src', '/api/blob/test.jpg?ref=feature');
    });

    it('uses default refs when not provided', () => {
      const file: DiffFile = {
        path: 'test.jpg',
        oldPath: 'old-test.jpg',
        status: 'modified',
        additions: 1,
        deletions: 1,
        chunks: [],
      };

      renderViewer(file);

      const images = screen.getAllByRole('img');
      expect(images[0]).toHaveAttribute('src', '/api/blob/old-test.jpg?ref=HEAD%7E1');
      expect(images[1]).toHaveAttribute('src', '/api/blob/test.jpg?ref=HEAD');
    });

    it('uses static blob URLs when available', () => {
      (
        window as Window & { __DIFIT_STATIC_BLOB_URLS__?: Record<string, string> }
      ).__DIFIT_STATIC_BLOB_URLS__ = {
        'abcdef1:test.jpg': '/difit/site-data/blobs/abcdef1/test.jpg',
      };
      const file: DiffFile = {
        path: 'test.jpg',
        status: 'added',
        additions: 1,
        deletions: 0,
        chunks: [],
      };

      renderViewer(file, { targetCommitish: 'abcdef1234567890' });

      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        '/difit/site-data/blobs/abcdef1/test.jpg',
      );
    });
  });

  describe('Image information display', () => {
    it('shows image dimensions and file size when available', async () => {
      const file: DiffFile = {
        path: 'test.jpg',
        status: 'added',
        additions: 1,
        deletions: 0,
        chunks: [],
      };

      renderViewer(file);

      const image = screen.getByRole('img');

      // Mock naturalWidth and naturalHeight
      Object.defineProperty(image, 'naturalWidth', { value: 800, configurable: true });
      Object.defineProperty(image, 'naturalHeight', { value: 600, configurable: true });

      // Simulate image load
      const loadEvent = new Event('load');
      image.dispatchEvent(loadEvent);

      // Wait for the state to update and info to be displayed
      await waitFor(() => {
        expect(screen.getByText(/W: 800px \| H: 600px/)).toBeInTheDocument();
        expect(screen.getByText(/1\.0 KB/)).toBeInTheDocument();
      });
    });
  });
});
