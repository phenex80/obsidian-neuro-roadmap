import esbuild from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const production = process.argv[2] === 'production';
const cssByFile = new Map();
const staticCssByFile = new Map();

const sveltePlugin = {
  name: 'svelte',
  setup(build) {
    build.onStart(() => {
      cssByFile.clear();
      staticCssByFile.clear();
    });
    build.onResolve({ filter: /\.css$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path),
      namespace: 'neuro-roadmap-css',
    }));
    build.onLoad({ filter: /.*/, namespace: 'neuro-roadmap-css' }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      staticCssByFile.set(args.path, source);
      return { contents: '', loader: 'js', watchFiles: [args.path] };
    });
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const compiled = compile(source, {
        filename: args.path,
        generate: 'client',
        dev: !production,
        css: 'external',
        runes: true,
      });

      for (const warning of compiled.warnings) {
        console.warn(warning.message);
      }

      if (compiled.css !== null) {
        cssByFile.set(args.path, compiled.css.code);
      }

      return {
        contents: compiled.js.code,
        loader: 'js',
      };
    });
    build.onEnd(async (result) => {
      if (result.errors.length > 0) {
        return;
      }

      const styles = [...staticCssByFile.entries(), ...cssByFile.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, css]) => css)
        .join('\n');
      await writeFile('styles.css', styles);
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'http', 'node:http', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  target: 'es2022',
  minify: production,
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  define: {
    __NEURO_ROADMAP_DEV__: JSON.stringify(!production),
  },
  plugins: [sveltePlugin],
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
