export default {
    collectCoverage: true,
    coverageDirectory: "coverage",
    coverageProvider: "v8",
    preset: 'ts-jest',
    roots: [ "src/" ],
    setupFiles: [ './jest.setup.ts' ],
    testMatch: ["**/*.test.ts"],
    watchman: false,
};
