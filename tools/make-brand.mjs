import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const size = 80;
const pixels = Buffer.alloc(size * (size * 4 + 1));
const palette = [[8, 127, 115], [45, 101, 181], [203, 76, 120]];
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  for (let x = 0; x < size; x++) {
    const offset = row + 1 + x * 4;
    let color = [244, 246, 247, 0];
    if (x >= 4 && x < 76 && y >= 4 && y < 76) color = [32, 42, 48, 255];
    for (let block = 0; block < 3; block++) {
      const start = 18 + block * 17;
      if (y >= start && y < start + 10 && x >= 17 && x < 29) color = [...palette[block], 255];
      if (y >= start + 3 && y < start + 7 && x >= 36 && x < 63 - block * 5) color = [238, 243, 245, 255];
    }
    for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = color[channel];
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'brand.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
]));
