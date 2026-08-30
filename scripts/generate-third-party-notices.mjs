import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const direct = new Set([
  ...Object.keys(lock.packages?.['']?.dependencies ?? {}),
  ...Object.keys(lock.packages?.['']?.devDependencies ?? {}),
]);
const packages = [];
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.startsWith('node_modules/') || !metadata?.version) continue;
  const name = packagePath.slice('node_modules/'.length);
  if (!direct.has(name)) continue;
  let license = metadata.license;
  let repository = metadata.repository;
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, packagePath, 'package.json'), 'utf8'));
    license ??= packageJson.license;
    repository ??= typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;
  } catch { /* package-lock data remains useful if node_modules is not installed */ }
  packages.push({ name, version: metadata.version, license: license ?? 'UNKNOWN', repository: repository ?? undefined });
}
packages.sort((left, right) => left.name.localeCompare(right.name));
await writeFile(path.join(root, 'THIRD_PARTY_LICENSES.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), packages }, null, 2)}\n`);
console.log(`wrote ${packages.length} direct dependency license records`);
