import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'assets');
fs.mkdirSync(directory, { recursive: true });
const size = 256;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const nodes = [[76, 164], [128, 76], [180, 164]];
const segmentDistance = (x, y, a, b) => {
  const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
  return Math.hypot(x - a[0] - t * (b[0] - a[0]), y - a[1] - t * (b[1] - a[1]));
};
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = y * (size * 4 + 1) + 1 + x * 4;
  const rounded = Math.hypot(Math.max(0, Math.abs(x - 127.5) - 88), Math.max(0, Math.abs(y - 127.5) - 88)) <= 32;
  let color = [20, 26, 39, rounded ? 255 : 0];
  if (nodes.some((node) => Math.hypot(x - node[0], y - node[1]) < 24)) color = [139, 203, 255, 255];
  else if ([[0, 1], [1, 2], [2, 0]].some(([a, b]) => segmentDistance(x, y, nodes[a], nodes[b]) < 5)) color = [79, 135, 213, 255];
  pixels.set(color, i);
}
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const content = Buffer.concat([Buffer.from(type), data]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); content.copy(output, 4); output.writeUInt32BE(crc32(content), output.length - 4);
  return output;
};
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(directory, 'icon.png'), png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([ico, png]));
