/** Tiny build tool for this project's named ES modules. No third-party tooling.
 * It resolves imports at build time and wraps each module in an isolated IIFE.
 * This intentionally supports only the module syntax used in this repository.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map(), visiting = new Set();
async function visit(rel) { if (modules.has(rel))
    return; if (visiting.has(rel))
    throw Error(`Circular dependency: ${rel}`); visiting.add(rel); let source = await fs.readFile(path.join(root, 'public', rel), 'utf8'); const pattern = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm; const imports = [...source.matchAll(pattern)]; for (const m of imports) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]));
    await visit(dep);
    const names = m[1].split(',').map(s => s.trim().replace(/\s+as\s+/, ':')).join(',');
    source = source.replace(m[0], `const {${names}} = __modules[${JSON.stringify(dep)}];\n`);
} const exports = [...source.matchAll(/^export\s+(?:async\s+)?(?:class|function|const|let)\s+([\w$]+)/gm)].map(m => m[1]); source = source.replace(/^export\s+/gm, ''); if (/^import\s/m.test(source))
    throw Error(`Unsupported import syntax: ${rel}`); visiting.delete(rel); modules.set(rel, { source, exports }); }
await visit('app.js');
const js = `(()=>{'use strict';const __modules=Object.create(null);\n${[...modules].map(([name, m]) => `// ===== ${name} =====\n__modules[${JSON.stringify(name)}]=(()=>{\n${m.source}\nreturn {${m.exports.join(',')}};\n})();`).join('\n')}\n})();`;
let html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
const css = await fs.readFile(path.join(root, 'public/app.css'), 'utf8');
html = html.replace('<link rel="stylesheet" href="app.css">', `<style>${css}</style>`).replace('<script type="module" src="app.js"></script>', `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
await fs.mkdir(path.join(root, 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'dist/Orivane.html'), html);
await fs.writeFile(path.join(root, 'dist/orivane.bundle.js'), js);
console.log(`Built standalone HTML: ${Buffer.byteLength(html).toLocaleString()} bytes; ${modules.size} isolated modules.`);
