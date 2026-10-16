import type { ReviewSettings } from '../../utils/reviewExport';

export function ReviewSettingsSection({
  settings,
  onChange,
}: {
  settings: ReviewSettings;
  onChange: (settings: ReviewSettings) => void;
}) {
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
    </div>
  );
}
