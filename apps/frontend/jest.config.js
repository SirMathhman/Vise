/** Jest config for the frontend.
 *
 * The two suites target the DOM-free stores (fileState.ts,
 * conversations.ts), which have no runtime relative imports, so we can
 * transpile to CommonJS and skip the fragile ESM vm-modules path.
 */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          allowJs: false,
        },
      },
    ],
  },
};
