import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const [sourceDirectory, outputFile] = process.argv.slice(2);
if (!sourceDirectory || !outputFile) {
  throw new Error('Usage: node scripts/hash-sample-corpus.mjs <read-only-source-directory> <manifest.json>');
}

const root = path.resolve(sourceDirectory);
const output = path.resolve(outputFile);
const supported = new Set(['.arw', '.dng', '.cr2', '.cr3', '.nef', '.raf', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.heic']);
const names = (await fs.readdir(root)).filter((name) => supported.has(path.extname(name).toLowerCase())).sort();
const files = [];
for (const name of names) {
  const filePath = path.join(root, name);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) continue;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  files.push({ name, size: stats.size, sha256: hash.digest('hex') });
  process.stdout.write(`[${files.length}/${names.length}] ${name}\n`);
}

const manifest = {
  format: 'chromik-read-only-sample-corpus',
  version: 1,
  generatedAt: new Date().toISOString(),
  sourceDirectory: root,
  policy: 'Samples are read-only, excluded from the repository, and never distributed with Chromik.',
  files,
};
await fs.mkdir(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await fs.rename(temporary, output);
process.stdout.write(`Wrote ${files.length} entries to ${output}\n`);
