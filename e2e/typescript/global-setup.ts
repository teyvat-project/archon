import { fileURLToPath } from 'node:url';
import { startMockServer } from '@archon/e2e-mock-server';
import { generate } from 'archon';
import { typescript } from 'archon/plugins';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
    secondaryUrl: string;
  }
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Generates the SDK twice: with the default options and with `dates: 'Date'`. */
export async function generateSdks(): Promise<void> {
  const input = 'fixtures/specs/edge-cases.yaml';
  await generate(
    [
      {
        input,
        output: 'e2e/typescript/generated/default',
        plugins: [typescript({ output: '.', package: false })],
      },
      {
        input,
        output: 'e2e/typescript/generated/dates',
        plugins: [typescript({ output: '.', package: false, dates: 'Date' })],
      },
    ],
    { cwd: repoRoot },
  );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await generateSdks();
  const server = await startMockServer();
  project.provide('baseUrl', server.url);
  project.provide('secondaryUrl', server.secondaryUrl);
  return () => server.close();
}
