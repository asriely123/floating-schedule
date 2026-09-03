// 生成程序图标（托盘 32px / 应用 256px），纯 Node 无依赖：淡蓝圆角方块 + 白色课表行
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgba) {  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形 SDF
function sdfRoundRect(px, py, cx, cy, w, h, r) {
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

const cover = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px 羽化

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const blend = (x, y, r, g, b, a) => {
    if (a <= 0) return;
    const i = (y * size + x) * 4;
    const dstA = buf[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    buf[i] = Math.round((r * a + buf[i] * dstA * (1 - a)) / outA);
    buf[i + 1] = Math.round((g * a + buf[i + 1] * dstA * (1 - a)) / outA);
    buf[i + 2] = Math.round((b * a + buf[i + 2] * dstA * (1 - a)) / outA);
    buf[i + 3] = Math.round(outA * 255);
  };
  const r = 0.22 * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const aBg = cover(sdfRoundRect(x + 0.5, y + 0.5, size / 2, size / 2, size - 1, size - 1, r));
      if (aBg <= 0) continue;
      blend(x, y, 74, 144, 217, aBg); // #4A90D9
      // 三条白色横排“课表行”
      for (const fy of [0.28, 0.49, 0.70]) {
        const aBar = cover(sdfRoundRect(
          x + 0.5, y + 0.5,
          size / 2, fy * size,
          0.44 * size, 0.10 * size, 0.05 * size
        ));
        if (aBar > 0) blend(x, y, 255, 255, 255, aBar * aBg * 0.95);
      }
    }
  }
  return encodePNG(size, size, buf);
}

function encodeICO(pngBytes, size) {
  // ICO 容器内嵌 PNG（Vista+ 支持）：ICONDIR + ICONDIRENTRY + PNG 数据
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 宽（0=256）
  entry[1] = size >= 256 ? 0 : size; // 高
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(pngBytes.length, 8);  // data size
  entry.writeUInt32LE(22, 12); // data offset
  return Buffer.concat([header, entry, pngBytes]);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'tray.png'), drawIcon(32));
fs.writeFileSync(path.join(assetsDir, 'icon.png'), drawIcon(256));
const iconPng = drawIcon(256);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), encodeICO(iconPng, 256));
console.log('icons written to assets/ (tray.png / icon.png / icon.ico)');
