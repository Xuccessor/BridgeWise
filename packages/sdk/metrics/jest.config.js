/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
