const resolve = require("@rollup/plugin-node-resolve");
const commonjs = require("@rollup/plugin-commonjs");
const rollupJson = require("@rollup/plugin-json");

module.exports = [
  {
    plugins: [resolve({ preferBuiltins: false }), commonjs(), rollupJson()],
    input: "./dist/index.js",
    output: [{ file: "dist/jitsu.es.js", format: "es" }],
  },
];
