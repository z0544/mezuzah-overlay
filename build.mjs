// Bundles src/app.js (with three.js) into one self-contained dist/index.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const r = await build({
  entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife',
  target: ['chrome110'], write: false, legalComments: 'eof',
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/index.template.html', 'utf8').replace('<script>/*__APP__*/</script>', () => `<script>${js}</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', (html.length / 1024).toFixed(0), 'KB');
