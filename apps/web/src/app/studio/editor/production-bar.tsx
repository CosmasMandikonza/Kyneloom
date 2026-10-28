'use client';

import type { ContractValidationError } from '@kyneloom/contracts';

/**
 * KYN-17 — the production header: identity, revision and unsaved state,
 * undo/redo, save (local demonstration mode), recompile, preview mode, and
 * the honest unavailability of approval/publishing (KYN-18/#21 do not exist).
 */

export type CompilePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ok'; readonly hash: string }
  | { readonly kind: 'rejected'; readonly errors: readonly ContractValidationError[] }
  | { readonly kind: 'stale'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface ProductionBarProps {
  readonly momentName: string;
  readonly draftId: string;
  readonly savedRevision: number;
  readonly unsaved: boolean;
  readonly draftDirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly compilePhase: CompilePhase;
  readonly saveBusy: boolean;
  readonly previewMode: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onSave: () => void;
  readonly onRecompile: () => void;
  readonly onTogglePreview: () => void;
}

export function ProductionBar({
  momentName,
  draftId,
  savedRevision,
  unsaved,
  draftDirty,
  canUndo,
  canRedo,
  compilePhase,
  saveBusy,
  previewMode,
  onUndo,
  onRedo,
  onSave,
  onRecompile,
  onTogglePreview,
}: ProductionBarProps) {
  return (
    <header className="studio-bar" data-production-bar="">
      <div className="studio-bar__brand">
        <span className="studio-bar__wordmark">Kyneloom Studio</span>
        <span className="studio-bar__divider" aria-hidden="true" />
        <span className="studio-bar__moment" data-moment-name="">
          {momentName}
        </span>
        <span className="chip chip--synthetic mono">Synthetic</span>
        <span
          className="chip chip--compiled mono"
          title="Local demonstration editing mode — drafts persist in THIS browser only (IndexedDB); not shared cloud projects. Server persistence arrives with authentication (KYN-21)."
        >
          Local draft · {draftId}
        </span>
      </div>
      <div className="studio-bar__state">
        <span className="studio-bar__revision mono" data-draft-revision="">
          draft rev {String(savedRevision)}
          {unsaved ? ' · UNSAVED' : ' · saved'}
        </span>
        <span
          className={`studio-bar__dot${unsaved ? ' studio-bar__dot--unsaved' : ''}`}
          data-unsaved-dot={unsaved ? 'true' : 'false'}
          title={unsaved ? 'Unsaved changes' : 'All changes saved locally'}
          aria-hidden="true"
        />
        {draftDirty ? (
          <span className="chip chip--amber mono" data-draft-preview-chip="true">
            Draft preview — recompile to verify
          </span>
        ) : (
          <span className="chip chip--evidence mono" data-compiled-baseline-chip="true">
            Compiled baseline
          </span>
        )}
      </div>
      <div className="studio-bar__actions">
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo the last edit (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          onClick={onSave}
          disabled={saveBusy}
          data-save-draft=""
          title="Save this draft locally (IndexedDB, compare-and-save on revision)"
        >
          {saveBusy ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className="btn btn--primary studio-bar__btn"
          onClick={onRecompile}
          disabled={compilePhase.kind === 'busy'}
          data-recompile=""
          title="Validate and recompile the draft through the deterministic compiler"
        >
          {compilePhase.kind === 'busy' ? 'Validating…' : 'Validate / Recompile'}
        </button>
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          aria-pressed={previewMode}
          onClick={onTogglePreview}
          title="Hide the editor chrome and watch the moment full-width"
        >
          {previewMode ? 'Exit preview' : 'Preview'}
        </button>
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          disabled
          title="Approval is a separate authorized server workflow (KYN-18) — no client can mint one"
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn--ghost studio-bar__btn"
          disabled
          title="Publishing requires the release workflow with rights checks (KYN-18) and authentication (KYN-21)"
        >
          Publish
        </button>
      </div>
    </header>
  );
}
