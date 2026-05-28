const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dist', 'index.html');

if (!fs.existsSync(filePath)) {
  console.error(`Error: ${filePath} does not exist.`);
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf8');

// Check for the ES module script tag
const target = '<script type="module" crossorigin>';
if (content.includes(target)) {
  console.log(`Found target ES module script tag. Replacing...`);
  content = content.replace(target, '<script defer>');
  
  // Also clean up any modulepreload polyfill that Vite injects, which is not needed in a single file
  // and might cause issues in a non-module environment.
  // The polyfill starts with (function(){const n=document.createElement("link").relList;...})()
  const polyfillRegex = /\(function\(\)\{const n=document\.createElement\("link"\)\.relList;[^}]*\}\)\(\);/;
  if (polyfillRegex.test(content)) {
    console.log('Found modulepreload polyfill. Removing...');
    content = content.replace(polyfillRegex, '');
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Successfully prepared index.html for local webview deployment (stripped ES Module tag, added defer, and stripped polyfill).');
} else {
  console.log('Warning: Target ES module script tag not found. Checking if already replaced.');
  if (content.includes('<script defer>')) {
    console.log('Already inlined and deferred.');
  } else {
    console.log('Could not find any script tag in dist/index.html');
  }
}
