/* Parses every generated .mmd with the real Mermaid parser, so a syntax error
 * can never silently degrade every diagram to the plain-source fallback.
 *
 * Mermaid and jsdom are NOT project dependencies. Point ERD_CHECK_MODULES at a
 * scratch install that has them, e.g.
 *   npm i mermaid@11 jsdom@25 --prefix <scratch>
 *   ERD_CHECK_MODULES=<scratch>/node_modules node scripts/erd/verify-mermaid.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const modules = process.env.ERD_CHECK_MODULES;
if (!modules || !fs.existsSync(modules)) {
  console.error('Set ERD_CHECK_MODULES to a node_modules dir containing mermaid@11 and jsdom@25.');
  console.error('Skipping: this check is optional and needs no project dependency change.');
  process.exit(0);
}

const req = (m) => require(path.join(modules, m));

(async () => {
  const { JSDOM } = req('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;

  const mermaid = (await import('file:///' + path.join(modules, 'mermaid', 'dist', 'mermaid.esm.mjs').replace(/\\/g, '/'))).default;
  mermaid.initialize({ startOnLoad: false, theme: 'neutral' });

  const dir = path.resolve(__dirname, '..', '..', 'docs', 'erd', 'diagrams');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort();
  let fail = 0;

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      await mermaid.parse(src);
      console.log(`PASS  ${f}`);
    } catch (e) {
      fail++;
      console.log(`FAIL  ${f}\n      ${String(e.message || e).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`\n${files.length - fail}/${files.length} diagrams parsed`);
  process.exit(fail ? 1 : 0);
})();
