// The drawing markup a scene may hold. A scene's svg goes into the page as markup, so anything that can run code,
// load a file or reach the network is refused: only these elements and attributes, and no markup beyond plain tags.
const ELEMENTS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title']);
const ATTRIBUTES = new Set(['class', 'id', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width',
  'height', 'points', 'transform', 'text-anchor', 'opacity']);
const DATA = /^data-[a-z][a-z0-9-]*$/;

/** What is wrong with a scene's svg, as a list of short reasons; empty when it is safe to put in the page. */
export function svgProblems(svg) {
  const problems = new Set();
  if (typeof svg !== 'string') return ['svg is not text'];
  let rest = svg;
  for (const m of svg.matchAll(/<(\/?)([^\s>/]*)([^>]*)>/g)) {
    rest = rest.replace(m[0], '');
    const [, close, name, body] = m;
    if (!ELEMENTS.has(name)) { problems.add(`<${name}> is not allowed`); continue; }
    if (close) { if (body.trim()) problems.add(`</${name}> has extra text`); continue; }
    const attrs = body.replace(/\/\s*$/, '');
    const left = attrs.replace(/\s+([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g, (a, key, value) => {
      if (!ATTRIBUTES.has(key) && !DATA.test(key)) problems.add(`attribute ${key} is not allowed`);
      if (/[<>]|&#|javascript:|url\s*\(/i.test(value)) problems.add(`attribute ${key} holds markup, a link or a code`);
      return '';
    });
    if (left.trim()) problems.add(`<${name}> has an attribute that is not name="value"`);
  }
  if (/[<>]/.test(rest)) problems.add('a < or > that is not part of an allowed tag');
  return [...problems];
}
