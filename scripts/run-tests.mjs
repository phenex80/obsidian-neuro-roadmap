import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const outputDirectory = resolve('.test-build');
const outputFile = resolve(outputDirectory, 'data-layer.test.mjs');
const obsidianTestStub = {
  name: 'obsidian-test-stub',
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({
      path: 'obsidian',
      namespace: 'obsidian-test-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'obsidian-test-stub' }, () => ({
      contents: `
        import { StateField } from '@codemirror/state';
        export const Platform = { isDesktopApp: true, isMobile: false };
        export const editorInfoField = StateField.define({
          create: () => ({ file: { path: 'note.md' } }),
          update: (value) => value,
        });
        export const editorLivePreviewField = StateField.define({
          create: () => true,
          update: (value) => value,
        });
        export const getLanguage = () => 'en';
        export const setIcon = () => {};
        export class Modal {}
        export class Setting {}
      `,
      loader: 'js',
      resolveDir: resolve('.'),
    }));
  },
};

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
    define: {
      __NEURO_ROADMAP_DEV__: 'false',
    },
    plugins: [obsidianTestStub],
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
