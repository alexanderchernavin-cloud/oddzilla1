// Root ESLint flat config. Workspace packages run `eslint .` from their
// own directory; ESLint 9 walks up the filesystem until it finds a config,
// so every package in the monorepo shares this one source of truth.
//
// Re-exports the shared rule set from `@oddzilla/eslint-config`. Using a
// relative path (rather than the workspace spec) lets Node resolve the
// parser/plugin deps from that package's own node_modules, so the root
// package.json does not need to list them.
module.exports = require("./packages/eslint-config/index.cjs");
