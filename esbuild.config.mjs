import esbuild from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFile } from 'node:fs/promises';

const production = process.argv[2] === 'production';

const sveltePlugin = {
  name: 'svelte',
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const compiled = compile(source, {
        filename: args.path,
        generate: 'client',
        dev: !production,
        css: 'injected',
        runes: true,
      });

      for (const warning of compiled.warnings) {
        console.warn(warning.message);
      }

      return {
        contents: compiled.js.code,
        loader: 'js',
      };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2022',
  minify: production,
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  plugins: [sveltePlugin],
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
