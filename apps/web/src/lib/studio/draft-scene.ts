import { cameraTrackToThree } from '@kyneloom/scene-renderer';
import { rescaleCameraTrackToWindow } from '@kyneloom/moment-compiler';
import type { MomentProposal } from '@kyneloom/contracts';
import type { SceneData } from '@/lib/scene-data';

/**
 * KYN-17 — bind a DRAFT's camera to the live preview scene.
 *
 * The same shared seam as `sceneWithCompiledTrack` (pitch→Three once through
 * `cameraTrackToThree`, then the moment's offsets re-expressed on the scene's
 * window exactly once) so a draft edit moves the ACTUAL 3D camera through the
 * existing directed rig — no second camera driver exists.
 */
export function sceneWithDraftCamera(base: SceneData, proposal: MomentProposal): SceneData {
  const directed = proposal.cameraTracks.find((track) => track.mode === 'directed');
  if (directed === undefined) return { ...base, directedTrack: null };
  const threeTrack = cameraTrackToThree(directed);
  const rescaled = rescaleCameraTrackToWindow(
    threeTrack,
    proposal.timeRangeMs[0],
    base.windowMs[0],
  );
  return { ...base, directedTrack: rescaled };
}
