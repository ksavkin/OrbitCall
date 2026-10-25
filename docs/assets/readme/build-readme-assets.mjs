// Generate theme-independent README logo badges and navigation images from source artwork.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const sharp = require('sharp');
const base = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(base, 'logos'), {recursive:true});
await mkdir(path.join(base, 'links'), {recursive:true});
const dataUri = async filename => {
  const bytes = await readFile(filename);
  return `data:${filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${bytes.toString('base64')}`;
};
for (const filename of (await readdir(path.join(base, 'icons'))).filter(f=>/\.(svg|png)$/.test(f))) {
  const name=path.parse(filename).name;
  const full=['cartesia','factory','grok','convex'].includes(name);
  const size=full?112:92, offset=(128-size)/2;
  const source=await dataUri(path.join(base,'icons',filename));
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><clipPath id="badge"><circle cx="64" cy="64" r="59"/></clipPath></defs><circle cx="64" cy="64" r="59" fill="white"/><image x="${offset}" y="${offset}" width="${size}" height="${size}" href="${source}" clip-path="url(#badge)"/><circle cx="64" cy="64" r="59" fill="none" stroke="#cbd5e1" stroke-width="2"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(base,'logos',name+'.png'));
}
const links=[
  {file:'live-demo',label:'Live demo',logo:'vercel',width:216},
  {file:'devpost',label:'Devpost',logo:'devpost',width:200},
  {file:'video',label:'Watch demo',logo:null,width:248}
];
for (const link of links) {
 const mark=link.logo?`<image x="12" y="8" width="48" height="48" href="${await dataUri(path.join(base,'logos',link.logo+'.png'))}"/>`:'<circle cx="36" cy="32" r="20" fill="#fff1f2"/><path d="M30 21 L48 32 L30 43 Z" fill="#be123c"/>';
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${link.width}" height="64" viewBox="0 0 ${link.width} 64"><rect x="1" y="1" width="${link.width-2}" height="62" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>${mark}<text x="72" y="40" font-family="Arial,Helvetica,sans-serif" font-size="25" font-weight="600" fill="#152238">${link.label}</text></svg>`;
 await writeFile(path.join(base,'links',link.file+'.svg'),svg+'\n');
 await sharp(Buffer.from(svg)).png().toFile(path.join(base,'links',link.file+'.png'));
}
await sharp(path.join(base,'architecture.svg')).png().toFile(path.join(base,'architecture.png'));
console.log('Built README logo badges, linked navigation images, and architecture PNG.');
