// Draws build/icon.svg with Electron's own Chromium and writes build/icon.ico (16 to 256 pixels), the icon of the
// installer, the program and its shortcuts. Run with `npm run icon` after changing the SVG.
//
// Sizes below 256 are stored as 32-bit bitmaps, 256 as PNG; both are standard ICO entries.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const RENDER = 512;

/** BITMAPINFOHEADER, bottom-up BGRA pixels with straight alpha, and the AND mask (all zero: alpha decides). */
function bitmapEntry(image, size) {
  const bgra = image.toBitmap(); // premultiplied BGRA, top-down
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows plus mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      const alpha = bgra[from + 3];
      for (let c = 0; c < 3; c++) pixels[to + c] = alpha ? Math.min(255, Math.round((bgra[from + c] * 255) / alpha)) : 0;
      pixels[to + 3] = alpha;
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((entry) => entry.data)]);
}

app.whenReady().then(async () => {
  const svg = readFileSync(join(buildDir, "icon.svg"), "utf8");
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${RENDER}px;height:${RENDER}px}</style>${svg}`;
  const win = new BrowserWindow({ width: RENDER, height: RENDER, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const full = await win.webContents.capturePage();
  const entries = SIZES.map((size) => {
    const image = full.resize({ width: size, height: size, quality: "best" });
    return { size, data: size >= 256 ? image.toPNG() : bitmapEntry(image, size) };
  });
  writeFileSync(join(buildDir, "icon.ico"), ico(entries));
  // `npm run icon -- --preview <file.png>` also writes the 256 px picture to look at
  const preview = process.argv.indexOf("--preview");
  if (preview > 0 && process.argv[preview + 1]) writeFileSync(process.argv[preview + 1], entries.at(-1).data);
  console.log(`build/icon.ico: ${SIZES.join(", ")} px (captured ${full.getSize().width}x${full.getSize().height})`);
  app.quit();
});
