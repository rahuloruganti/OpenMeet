// Public API of entities/processing. Other slices import only from this file.
export {
  builtinTemplates,
  forgetLegacyProcessing,
  legacyProcessing,
  modeLabels,
  processingDefault,
  stageLabel,
} from "./processing";
export type { ProcessingChoice } from "./processing";
