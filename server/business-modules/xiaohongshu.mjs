import { inflateSync } from 'node:zlib';
import { z } from 'zod';

export const xiaohongshuModule = Object.freeze({ id: 'xiaohongshu', version: '1', name: '小红书图文运营',
  contentType: 'image-note', approvalType: 'desktop-native-publication',
  roles: ['owner', 'researcher', 'writer', 'visual', 'reviewer'],
  tools: ['research.read', 'template.render', 'material.read', 'publication.candidates', 'metrics.read'],
  workflow: ['plan', 'research', 'write', 'visual', 'review', 'integrate', 'approve', 'publish', 'verify', 'retrospective'],
  limits: { titleCharacters: 20, bodyCharacters: 1000, tags: 10, images: 9, imageBytes: 20 * 1024 * 1024 } });

export const notePayloadSchema = z.object({ title: z.string().max(200), body: z.string().max(20000),
  tags: z.array(z.string().max(100)).max(30).default([]), visibility: z.enum(['public', 'private']).default('public'),
  schedule: z.object({ kind: z.enum(['immediate', 'scheduled']), startsAt: z.string().datetime().optional() }).strict().default({ kind: 'immediate' }) });

export function normalizeNotePayload(input) {
  const parsed = notePayloadSchema.parse(input);
  return { title: parsed.title.normalize('NFC').replace(/\r?\n/g, ' ').trim(),
    body: parsed.body.normalize('NFC').replace(/\r\n?/g, '\n').trim(),
    tags: [...new Set(parsed.tags.map(tag => tag.normalize('NFC').replace(/^#+/, '').trim()))],
    visibility: parsed.visibility, schedule: parsed.schedule };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
const pngCrc = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > xiaohongshuModule.limits.imageBytes) throw new Error('图片内容缺失或超过 20 MiB');
  let width, height, mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw new Error('PNG 头无效');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mime = 'image/png';
    if (width < 1 || height < 1 || width * height > 16_777_216) throw new Error('图片画布超过校验上限');
    const depth = bytes[24], type = bytes[25], interlace = bytes[28];
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[type];
    if (!channels || ![1, 2, 4, 8, 16].includes(depth) || [2, 4, 6].includes(type) && depth < 8 || type === 3 && depth > 8 ||
        interlace !== 0 || bytes[26] !== 0 || bytes[27] !== 0) throw new Error('PNG 色彩或压缩格式不受支持');
    let offset = 8, ended = false, hasPalette = false;
    const chunks = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), name = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      if (offset + length + 12 > bytes.length) throw new Error('PNG 数据不完整');
      if (pngCrc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error('PNG 数据校验码不一致');
      if (name === 'PLTE') hasPalette = length > 0 && length <= 768 && length % 3 === 0;
      if (name === 'acTL') throw new Error('图文稿件不接受动画 PNG');
      if (name === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
      if (name === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!ended || !chunks.length || type === 3 && !hasPalette) throw new Error('PNG 图片数据缺失');
    const rowBytes = Math.ceil(width * channels * depth / 8), expectedBytes = (rowBytes + 1) * height;
    const decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: Math.min(expectedBytes + 1, 140 * 1024 * 1024) });
    if (decoded.length !== expectedBytes) throw new Error('PNG 解码尺寸与头信息不一致');
    for (let row = 0; row < height; row++) if (decoded[row * (rowBytes + 1)] > 4) throw new Error('PNG 扫描行无效');
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('JPEG 数据不完整');
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG 标记无效');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 段数据无效');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw new Error('JPEG 画布信息缺失');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (!width || !height || width * height > 16_777_216) throw new Error('JPEG 图片画布无效');
  } else throw new Error('只接受真实 PNG 或 JPEG 图片');
  return { width, height, mime, size: bytes.length };
}

export function checkNotePayload(revision) {
  const findings = [], { limits } = xiaohongshuModule;
  const add = (code, message) => findings.push({ code, message, severity: 'error' });
  if (!revision.title || [...revision.title].length > limits.titleCharacters) add('title_length', `标题需为 1 至 ${limits.titleCharacters} 字`);
  const publishedText = [revision.body, ...revision.tags.map(tag => `#${tag}`)].filter(Boolean).join('\n');
  if (!revision.body || [...publishedText].length > limits.bodyCharacters) add('body_length', `正文与话题合计需为 1 至 ${limits.bodyCharacters} 字`);
  if (revision.tags.length > limits.tags || revision.tags.some(tag => !tag || /[\s#<>]/u.test(tag))) add('tags', '话题最多 10 个，且不能包含空格、井号或尖括号');
  if (!revision.images.length || revision.images.length > limits.images) add('image_count', `整稿需要 1 至 ${limits.images} 张实际图片`);
  if (!Array.isArray(revision.sources) || !revision.sources.length) add('sources_missing', '整稿缺少来源说明');
  if (revision.schedule.kind === 'scheduled' && !revision.schedule.startsAt) add('schedule_missing', '定时发布需要明确的开始时间');
  for (const [index, image] of revision.images.entries()) {
    if (image.width < 320 || image.height < 320 || image.width > 4096 || image.height > 4096) add('image_dimensions', `第 ${index + 1} 张图片尺寸需在 320 至 4096 像素之间`);
    if (!image.source) add('image_source', `第 ${index + 1} 张图片缺少素材来源`);
    if (image.templateVersion && image.renderCheck?.passed !== true) add('template_layout', `第 ${index + 1} 张模板图尚未通过实际排版检查`);
    if (image.renderCheck?.overflow === true || image.renderCheck?.missingAssets?.length) add('template_render', `第 ${index + 1} 张图片存在溢出或缺失素材`);
  }
  return { passed: findings.length === 0, findings };
}
