// The plan drawing of the control room is put into the page as inline SVG, so that its lines take the theme's
// colour. The API checks a drawing when it is imported (apps/api src/control-room/plan.ts); the page checks it again
// with the same rules before it trusts it, and draws the zones alone when the check fails.

const ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc", "defs", "use", "symbol",
  "clippath", "mask", "pattern", "lineargradient", "radialgradient", "stop", "text", "tspan", "metadata",
]);

const TAG = /<\s*([A-Za-z][\w:.-]*)([^>]*)>/g;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;

export function isSafePlanSvg(text: string): boolean {
  if (text.length > 2 * 1024 * 1024) return false;
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<!\[CDATA\[/i.test(text)) return false;
  const body = text.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trimStart();
  if (!/^<svg[\s>]/.test(body)) return false;
  for (const tag of body.matchAll(TAG)) {
    const name = (tag[1] ?? "").toLowerCase().replace(/^svg:/, "");
    if (!ELEMENTS.has(name)) return false;
    for (const attribute of (tag[2] ?? "").matchAll(ATTRIBUTE)) {
      const key = (attribute[1] ?? "").toLowerCase();
      const value = (attribute[3] ?? attribute[4] ?? attribute[5] ?? "").trim();
      if (key.startsWith("on")) return false;
      if ((key === "href" || key.endsWith(":href")) && !value.startsWith("#")) return false;
      if (/url\s*\(\s*(?!['"]?#)/i.test(value)) return false;
      if (/javascript:|data:|@import/i.test(value)) return false;
    }
  }
  return true;
}

/** Width and height of the root viewBox; the zone fractions are laid over a box of this shape. */
export function planAspect(text: string): { width: number; height: number } | null {
  const root = /<svg\b([^>]*)>/.exec(text);
  const match = root ? /\bviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/.exec(root[1] ?? "") : null;
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}
