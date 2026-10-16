import { PanelLeft, PanelLeftClose, Settings } from 'lucide-react';

export function ReviewLayoutControls({
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onToggleSidebar}
        className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
        title={sidebarOpen ? 'Collapse file tree' : 'Expand file tree'}
        aria-expanded={sidebarOpen}
        aria-controls="file-tree-panel"
        aria-label="Toggle file tree panel"
      >
        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
      </button>
      <button
        onClick={onOpenSettings}
        className="p-2 text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary rounded transition-colors"
        title="Settings"
      >
        <Settings size={18} />
      </button>
    </div>
  );
}
