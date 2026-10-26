import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Feature-Sliced Design layer order, top to bottom. A file may import only from
// strictly lower layers; slices inside one layer are independent of each other
// and expose their code only through their own index.ts.
const layers = ["app", "pages", "widgets", "features", "entities", "shared"];

// Slices per layer. `shared` holds plain modules (no index.ts), so it has no slices.
const slices = {
  pages: ["meeting", "settings", "setup"],
  widgets: [
    "first-run-setup",
    "library-question",
    "meeting-sidebar",
    "meeting-workspace",
    "recording-controls",
    "settings-panel",
    "setup-panel",
  ],
  features: [
    "action-items",
    "auto-capture",
    "live-settings",
    "live-transcript",
    "local-ai",
    "meeting-tags",
    "model-library",
    "note-writer",
    "provider-settings",
    "recipes",
    "rewrite-selection",
    "speaker-names",
    "summary-templates",
    "transcription-settings",
    "transcript-versions",
  ],
  entities: ["meeting", "processing"],
};

// Tests may import anything inside src, including another slice's internals.
const tests = ["**/*.test.ts", "**/*.test.tsx"];
const testSupport = ["src/shared/test/**"];

const importRule = (patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

/** Relative specifiers pointing at `target`, bare or with a path below it. */
const reach = (target) => [`**/${target}`, `**/${target}/**`];

/** A sibling slice is reached from inside the layer, so its specifier has no layer name. */
const up = ["../", "../../", "../../../"];
const reachSibling = (slice) =>
  up.flatMap((prefix) => [`${prefix}${slice}`, `${prefix}${slice}/**`]);

/** A lower layer's slices entered through anything but their index.ts. */
const indexOnly = (layer) => [`**/${layer}/*/*`, `!**/${layer}/*/index`];

const layerPatterns = (layer) =>
  layers.slice(0, layers.indexOf(layer)).map((higher) => ({
    group: reach(higher),
    message: `${layer} may not import from ${higher}: imports point to lower layers only.`,
  }));

const siblingPatterns = (layer, slice) =>
  slices[layer]
    .filter((other) => other !== slice)
    .map((other) => ({
      group: reachSibling(other),
      message: `Slices in ${layer} may not import each other; move shared code down a layer.`,
    }));

const publicApiPatterns = (layer) =>
  layers
    .slice(layers.indexOf(layer) + 1)
    .filter((name) => name in slices)
    .map((name) => ({
      group: indexOnly(name),
      message: `Import a ${name} slice through its index.ts, not a deep path.`,
    }));

const boundaryConfigs = layers.flatMap((layer) => {
  const patterns = [...layerPatterns(layer), ...publicApiPatterns(layer)];
  const shared = {
    files: [`src/${layer}/**`],
    ignores: [...tests, ...testSupport],
    rules: importRule(patterns),
  };
  const perSlice = (slices[layer] ?? []).map((slice) => ({
    files: [`src/${layer}/${slice}/**`],
    ignores: [...tests, ...testSupport],
    rules: importRule([...patterns, ...siblingPatterns(layer, slice)]),
  }));
  return [shared, ...perSlice];
});

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist/**", "node_modules/**"] },
  ...boundaryConfigs,
);
