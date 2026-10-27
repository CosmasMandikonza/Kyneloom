/**
 * KYN-17 — the Studio's single selection model.
 *
 * One canonical selection across rail, timeline and inspector (docs/16:
 * "one active selection; object and playhead persist"). Ids are the draft's
 * own typed ids: camera track ids, overlay ids, claim ids, scene event ids.
 */
export type StudioSelection =
  | { readonly kind: 'shot'; readonly id: string }
  | { readonly kind: 'overlay'; readonly id: string }
  | { readonly kind: 'caption'; readonly id: string; readonly claimId: string }
  | { readonly kind: 'event'; readonly id: string };

/** The hypothesis claim bound to a caption overlay (the compiler's own rule). */
export function captionClaimIdFor(
  overlay: { readonly kind: string; readonly evidenceIds: readonly string[] },
  claims: readonly {
    readonly id: string;
    readonly status: string;
    readonly evidenceIds: readonly string[];
  }[],
): string | null {
  const claim = claims.find(
    (candidate) =>
      candidate.status === 'hypothesis' &&
      candidate.evidenceIds.some((id) => overlay.evidenceIds.includes(id)),
  );
  return claim?.id ?? null;
}
