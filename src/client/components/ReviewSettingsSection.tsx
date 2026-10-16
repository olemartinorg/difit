import { useState } from 'react';

import { formatReviewExport, type ReviewSettings } from '../../utils/reviewExport';

export function ReviewSettingsSection({
  settings,
  onChange,
  review,
}: {
  settings: ReviewSettings;
  onChange: (settings: ReviewSettings) => void;
  review: string;
}) {
  const [separatorInput, setSeparatorInput] = useState(() =>
    settings.separator.replace(
      /[\n\r\t\\]/g,
      (character) =>
        ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\' })[character] ?? character,
    ),
  );
  const valid = settings.template.includes('{{review}}');
  const inputClass =
    'w-full p-2 bg-github-bg-tertiary border border-github-border rounded text-sm font-mono';
  return (
    <div className="space-y-5">
      <label className="flex items-center gap-2 text-sm">
        Repository updates
        <select
          aria-label="Repository updates"
          value={settings.autoRefresh ? 'automatic' : 'manual'}
          onChange={(event) =>
            onChange({ ...settings, autoRefresh: event.target.value === 'automatic' })
          }
          className="p-2 bg-github-bg-tertiary border border-github-border rounded"
        >
          <option value="automatic">Automatic</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.resetViewedAfterExport}
          onChange={(event) =>
            onChange({ ...settings, resetViewedAfterExport: event.target.checked })
          }
        />
        Reset viewed files after exporting
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.clearCommentsAfterExport}
          onChange={(event) =>
            onChange({ ...settings, clearCommentsAfterExport: event.target.checked })
          }
        />
        Clear review comments after exporting
      </label>
      <label className="block text-sm space-y-2">
        <span>Review template</span>
        <textarea
          aria-label="Review template"
          rows={6}
          spellCheck={false}
          value={settings.template}
          onChange={(event) => onChange({ ...settings, template: event.target.value })}
          className={inputClass}
          aria-invalid={!valid}
        />
        <span
          className={`block text-xs ${valid ? 'text-github-text-secondary' : 'text-github-danger'}`}
        >
          {'Use {{review}} to insert the review.'}
        </span>
      </label>
      <label className="block text-sm space-y-2">
        <span>Comment separator</span>
        <input
          aria-label="Comment separator"
          type="text"
          spellCheck={false}
          value={separatorInput}
          onChange={(event) => {
            setSeparatorInput(event.target.value);
            onChange({
              ...settings,
              separator: event.target.value.replace(
                /\\(n|r|t|\\)/g,
                (_, escape: string) =>
                  ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[escape] ?? escape,
              ),
            });
          }}
          className={inputClass}
        />
        <span className="block text-xs text-github-text-secondary">Use \n for a new line.</span>
      </label>
      <div className="text-sm space-y-2">
        <span>Preview</span>
        <pre
          aria-label="Review export preview"
          className="p-3 bg-github-bg-tertiary border border-github-border rounded text-xs whitespace-pre-wrap break-words max-h-56 overflow-auto"
        >
          {valid
            ? formatReviewExport(
                review ||
                  [
                    'src/example.ts:L12\nDescribe the change needed here.',
                    'src/example.ts:L24\nAnother review comment.',
                  ].join(settings.separator),
                settings.template,
              )
            : 'Template must contain {{review}}.'}
        </pre>
      </div>
    </div>
  );
}
