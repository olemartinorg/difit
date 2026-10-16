import { diffArrays } from 'diff';

import type { DiffChunk, DiffSide, LineNumber } from '../../types/diff';

export interface DraftSelection {
  side: DiffSide;
  lineNumber: LineNumber;
}

interface SourceLine {
  number: number;
  content: string;
}

export interface DraftAnchor extends DraftSelection {
  source: SourceLine[];
  code: string;
}

function sideLines(chunks: DiffChunk[], side: DiffSide): SourceLine[] {
  const lines = new Map<number, string>();
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      const number = side === 'old' ? line.oldLineNumber : line.newLineNumber;
      if (number !== undefined) lines.set(number, line.content);
    }
  }
  return [...lines].sort(([a], [b]) => a - b).map(([number, content]) => ({ number, content }));
}

export function createDraftAnchor(selection: DraftSelection, chunks: DiffChunk[]): DraftAnchor {
  const source = sideLines(chunks, selection.side);
  const [start, end] = Array.isArray(selection.lineNumber)
    ? selection.lineNumber
    : [selection.lineNumber, selection.lineNumber];
  return {
    ...selection,
    source,
    code: source
      .filter((line) => line.number >= start && line.number <= end)
      .map((line) => line.content)
      .join('\n'),
  };
}

export function resolveDraftAnchor(anchor: DraftAnchor, chunks: DiffChunk[]) {
  const current = sideLines(chunks, anchor.side);
  const mapped = new Map<number, number>();
  let before = 0;
  let after = 0;
  for (const change of diffArrays(
    anchor.source.map((line) => line.content),
    current.map((line) => line.content),
  )) {
    if (!change.added && !change.removed) {
      for (let i = 0; i < change.value.length; i++) {
        const oldLine = anchor.source[before + i];
        const newLine = current[after + i];
        if (oldLine && newLine) mapped.set(oldLine.number, newLine.number);
      }
    }
    if (!change.added) before += change.value.length;
    if (!change.removed) after += change.value.length;
  }
  const [start, end] = Array.isArray(anchor.lineNumber)
    ? anchor.lineNumber
    : [anchor.lineNumber, anchor.lineNumber];
  const first = mapped.get(start);
  const last = mapped.get(end);
  const unchanged =
    first !== undefined &&
    last !== undefined &&
    Array.from({ length: end - start + 1 }, (_, i) => mapped.get(start + i)).every(
      (number, i) => number === first + i,
    );
  return {
    side: anchor.side,
    lineNumber: unchanged
      ? ((Array.isArray(anchor.lineNumber) ? [first, last] : first) as LineNumber)
      : anchor.lineNumber,
    outdated: !unchanged,
  };
}
