import esbuild from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFile, writeFile } from 'node:fs/promises';

const production = process.argv[2] === 'production';
const cssByFile = new Map();

const sveltePlugin = {
  name: 'svelte',
  setup(build) {
    build.onStart(() => {
      cssByFile.clear();
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

      const styles = Array.from(cssByFile.entries())
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
  external: ['obsidian', 'node:http'],
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
