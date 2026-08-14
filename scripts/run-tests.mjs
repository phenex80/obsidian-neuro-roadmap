import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const outputDirectory = resolve('.test-build');
const outputFile = resolve(outputDirectory, 'data-layer.test.mjs');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

try {
  await build({
    entryPoints: ['tests/data-layer.test.ts'],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'silent',
  });

  const exitCode = await new Promise((resolveExitCode, reject) => {
    const child = spawn(process.execPath, ['--test', outputFile], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolveExitCode(code ?? 1));
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
