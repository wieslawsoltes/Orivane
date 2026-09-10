/** Build an allowlisted, subpath-safe GitHub Pages artifact. No server data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [path.join(root, 'tools/build.js')], { cwd: root, stdio: 'inherit' });
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const hashes = {};
async function copyPublic(dir, relative = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = path.posix.join(relative, entry.name);
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw Error(`Refusing hidden file or symbolic link: ${rel}`);
        if (entry.isDirectory()) { await fs.mkdir(path.join(out, rel), { recursive: true }); await copyPublic(path.join(dir, entry.name), rel); }
        else if (entry.isFile()) {
            if (!/\.(?:html|css|js|json|svg|png|jpe?g|webp|gif|ico|woff2?)$/i.test(entry.name)) throw Error(`Unexpected public file: ${rel}`);
            const bytes = await fs.readFile(path.join(dir, entry.name));
            await fs.writeFile(path.join(out, rel), bytes);
            hashes[rel] = createHash('sha256').update(bytes).digest('hex');
        }
    }
}
await copyPublic(path.join(root, 'public'));
const portable = await fs.readFile(path.join(root, 'dist/Orivane.html'));
await fs.writeFile(path.join(out, 'Orivane.html'), portable);
hashes['Orivane.html'] = createHash('sha256').update(portable).digest('hex');
await fs.writeFile(path.join(out, '.nojekyll'), '');
let commit = process.env.GITHUB_SHA || null;
if (!commit) { try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {} }
await fs.writeFile(path.join(out, 'build.json'), JSON.stringify({ name: pkg.name, version: pkg.version, commit, edition: 'local-browser', files: hashes }, null, 2) + '\n');
console.log(`Pages artifact: ${Object.keys(hashes).length} public files, version ${pkg.version}, commit ${commit || 'local build'}`);
