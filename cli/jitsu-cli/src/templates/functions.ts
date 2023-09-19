import { ProjectTemplate } from "../lib/template";
import { jitsuCliVersion, jitsuPackageName } from "../lib/version";
import { sanitize } from "juava";

export type TemplateVars = {
  license?: "MIT" | "Other";
  packageName: string;
  jitsuVersion?: string;
};

export const packageJsonTemplate = ({ packageName, license = "MIT", jitsuVersion = undefined }: TemplateVars) => ({
  name: `${packageName}`,
  version: "0.0.1",
  description: `Jitsu extension - ${packageName}`,
  license: license,
  keywords: ["jitsu", "jitsu-cli", "function", `jitsu-extension`],
  main: `dist/index.js`,
  scripts: {
    clean: "rm -rf ./dist",
    build: `${jitsuPackageName} build`,
    test: `${jitsuPackageName} test`,
    deploy: `${jitsuPackageName} deploy`,
  },
  devDependencies: {
    "jitsu-cli": `${jitsuCliVersion}`,
    "@jitsu/protocols": `${jitsuVersion || "^" + jitsuCliVersion}`,
    "@types/jest": "^29.5.5",
    "ts-jest": "^29.1.1",
  },
  dependencies: {},
});

let functionTest = ({ packageName }: TemplateVars) => {
  return `
test("${sanitize(packageName)} test", () => {
  //TODO: implement test
});
`;
};

let functionCode = ({ packageName }: TemplateVars) => {
  return `
import { JitsuFunction } from "@jitsu/protocols/functions";
import { AnalyticsServerEvent } from "@jitsu/protocols/analytics";

const ${sanitize(packageName)}: JitsuFunction<AnalyticsServerEvent, any> = async (event, ctx) => {
    //TODO: implement function logic
};

export default ${sanitize(packageName)};
`;
};

export const functionProjectTemplate: ProjectTemplate<TemplateVars> = ({ packageName }: TemplateVars) => ({
  [`__test__/${sanitize(packageName)}.test.ts`]: functionTest,
  [`src/index.ts`]: functionCode,
  "package.json": packageJsonTemplate,
  "tsconfig.json": {
    compilerOptions: {
      rootDir: "./src",
      outDir: "./dist",
      declaration: true,
      esModuleInterop: true,
      importHelpers: false,
      module: "esnext",
      lib: ["esnext", "dom"],
      noEmit: false,
      target: "esnext",
    },
    target: "esnext",
    exclude: ["__tests__", "node_modules", "dist"],
  },
});
