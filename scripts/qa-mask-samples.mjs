import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { estimateDensityAnchors, estimateFilmBaseRobust } = require('../dist-main/core/density.js');
const { processRgb8 } = require('../dist-main/core/reconstruct.js');
const { createDefaultRecipe } = require('../dist-main/shared/defaults.js');

const inputDirectory = path.resolve(process.argv[2] ?? '.');
const outputDirectory = path.resolve(process.argv[3] ?? '/tmp/chromik-mask-qa');
await mkdir(outputDirectory, { recursive: true });

function percentile(values, fraction) {
  const sorted = values.sort((left, right) => left - right);
  return sorted[Math.round((sorted.length - 1) * fraction)] ?? 0;
}

function outputStats(pixels, channels) {
  const luminance = [];
  let white = 0;
  let black = 0;
  for (let index = 0; index < pixels.length; index += channels) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    luminance.push(red * .2126 + green * .7152 + blue * .0722);
    if (red >= 245 && green >= 245 && blue >= 245) white += 1;
    if (red <= 10 && green <= 10 && blue <= 10) black += 1;
  }
  return {
    p01: Math.round(percentile([...luminance], .01)),
    p50: Math.round(percentile([...luminance], .5)),
    p99: Math.round(percentile([...luminance], .99)),
    whiteRatio: Number((white / luminance.length).toFixed(4)),
    blackRatio: Number((black / luminance.length).toFixed(4)),
  };
}

const files = (await readdir(inputDirectory)).filter((name) => /\.(?:jpe?g|png|tiff?)$/i.test(name)).sort();
const results = [];
for (const name of files) {
  const sourcePath = path.join(inputDirectory, name);
  const { data, info } = await sharp(sourcePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const base = estimateFilmBaseRobust(data, info.width, info.height, info.channels, 'camera_srgb');
  const anchors = estimateDensityAnchors(data, info.width, info.height, info.channels, base.rgb, {
    inputTransfer: 'srgb',
    profileId: 'camera_srgb',
    filmProfileId: 'generic_color_negative',
    neutralProtection: 55,
    separation: 0,
  });
  const variants = {
    current: anchors,
    zeroDmin: { ...anchors, low: [0, 0, 0] },
    zeroDminProtected: { ...anchors, low: [0, 0, 0], shadowCorrection: [0, 0, 0], highlightCorrection: [0, 0, 0] },
  };
  const outputs = {};
  for (const [variant, density] of Object.entries(variants)) {
    const recipe = createDefaultRecipe();
    recipe.baseRgb = base.rgb;
    recipe.density = { ...recipe.density, enabled: true, ...density };
    const rendered = processRgb8(data, info.channels, recipe);
    const outputPath = path.join(outputDirectory, `${path.parse(name).name}-${variant}.jpg`);
    await sharp(Buffer.from(rendered), { raw: info }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(outputPath);
    outputs[variant] = { outputPath, stats: outputStats(rendered, info.channels) };
  }
  results.push({
    name,
    base,
    anchors,
    outputs,
  });
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
