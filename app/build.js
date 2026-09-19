// Turns the single-file src.html (CDN React/Babel/Tailwind) into an offline www/ bundle.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const babel = require('@babel/core');
const W = 'www';
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W + '/fonts', { recursive: true });
let html = fs.readFileSync('src.html', 'utf8');

// 1. Precompile the JSX block
const m = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/);
const js = babel.transformSync(m[1], { presets: [['@babel/preset-react',{runtime:'classic',development:false}]], compact: true }).code;
fs.writeFileSync(W + '/app.js', js);

// 2. Vendor React
fs.copyFileSync('node_modules/react/umd/react.production.min.js', W + '/react.js');
fs.copyFileSync('node_modules/react-dom/umd/react-dom.production.min.js', W + '/react-dom.js');

// 3. Tailwind CSS (scan the original source)
fs.writeFileSync('tw.config.js', "module.exports={content:['./src.html'],corePlugins:{preflight:true}}");
fs.writeFileSync('tw.in.css', '@tailwind base;@tailwind components;@tailwind utilities;');
cp.execSync('npx tailwindcss -c tw.config.js -i tw.in.css -o ' + W + '/tw.css --minify', { stdio: 'inherit' });

// 4. Fonts
const fonts = [];
const add = (pkg, fam, weights, subsets) => weights.forEach(w => subsets.forEach(s => {
  const f = `${pkg}-${s}-${w}-normal.woff2`;
  const src = `node_modules/@fontsource/${pkg}/files/${f}`;
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, `${W}/fonts/${f}`);
  fonts.push(`@font-face{font-family:'${fam}';font-weight:${w};font-display:swap;src:url(fonts/${f}) format('woff2')}`);
}));
add('archivo', 'Archivo', [600, 700, 800], ['latin']);
add('ibm-plex-mono', 'IBM Plex Mono', [400, 500, 600], ['latin']);
add('ibm-plex-sans-thai', 'IBM Plex Sans Thai', [400, 500, 600], ['thai', 'latin']);
fs.writeFileSync(W + '/fonts.css', fonts.join('\n'));

// 5. Rewrite HTML
html = html
  .replace(/<link rel="preconnect"[^>]*>\s*/, '')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/, '<link rel="stylesheet" href="fonts.css"><link rel="stylesheet" href="tw.css">')
  .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\s*/, '')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/react@[^>]*><\/script>/, '<script src="react.js"></script>')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/react-dom@[^>]*><\/script>/, '<script src="react-dom.js"></script>')
  .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@babel[^>]*><\/script>/, '')
  .replace(m[0], '<script src="app.js"></script>')
  .replace('|| !window.Babel', '');
fs.writeFileSync(W + '/index.html', html);
console.log('built', fs.readdirSync(W));
