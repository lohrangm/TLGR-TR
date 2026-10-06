import { build } from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";

// teleproto's StoreSession (file-based session storage) is never used by us -
// we only use StringSession (in-memory, saved to Tampermonkey storage by our
// own code). Its only purpose for pulling in node-localstorage is file-backed
// sessions, which drags in write-file-atomic -> graceful-fs, and graceful-fs
// patches fs.Stats.prototype in a way that breaks under esbuild's fs polyfill
// (cyclic __proto__). Stubbing node-localstorage to an empty module removes
// that whole unreachable-for-us dependency chain.
const stubEmptyModules = {
  name: "stub-empty-modules",
  setup(buildApi) {
    const targets = new Set(["node-localstorage", "write-file-atomic"]);
    buildApi.onResolve({ filter: /.*/ }, (args) => {
      if (targets.has(args.path)) {
        return { path: args.path, namespace: "stub-empty" };
      }
      return null;
    });
    buildApi.onLoad({ filter: /.*/, namespace: "stub-empty" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["entry.js"],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "TeleprotoBridgeModule",
  outfile: "bundle.js",
  plugins: [
    stubEmptyModules,
    polyfillNode({
      polyfills: {
        fs: true,
        path: true,
        os: true,
        events: true,
        util: true,
        crypto: true,
        net: "empty",
        "node:net": "empty",
        "timers/promises": "empty",
        "node:timers/promises": "empty",
      },
    }),
  ],
  logLevel: "info",
  logLimit: 0,
});
