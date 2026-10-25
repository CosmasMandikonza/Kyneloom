export { metricToolContextFrom, type CompilerSourceContext } from './source-context';
export {
  compileMomentProposal,
  rescaleCameraTrackToWindow,
  type CompileResult,
  type CompileSuccess,
  type VerifiedMetric,
} from './compile';
export { eventCueText, eventFactSentence, metricCueText, metricFactSentence } from './facts';
export { buildManifestPresentation, type OverlayBinding } from './presentation';
export {
  canonicalAssetLocation,
  describeAssetLocation,
  isAssetUrlWithinScopes,
  parseAssetScope,
  type AssetScope,
} from './asset-scope';
export {
  buildCompileCorpus,
  selectHeroCandidate,
  type CompileCorpus,
  type CorpusEntry,
} from './corpus';
