const fs = require('fs');
const vm = require('vm');

console.log('--- DIAGNOSTIC START ---');

const html = fs.readFileSync('dist/index.html', 'utf8');

// Extract script content
const scriptStartRegex = /<script[^>]*>/;
const scriptEndTag = '</script>';

const match = html.match(scriptStartRegex);
const startIndex = match ? match.index : -1;
const endIndex = html.indexOf(scriptEndTag);

if (startIndex === -1 || endIndex === -1) {
  console.error('Could not find script block in dist/index.html!');
  process.exit(1);
}

const jsCode = html.slice(startIndex + match[0].length, endIndex);
console.log(`Successfully extracted script block (length: ${jsCode.length} chars)`);

// Mock browser environment
const domListeners = {};
const globalMock = {
  window: {},
  addEventListener: (event, callback) => {
    console.log(`[WINDOW] Registered listener for event: ${event}`);
  },
  console: {
    log: (...args) => console.log('[LOG]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  document: {
    readyState: 'loading',
    addEventListener: (event, callback) => {
      console.log(`[DOM] Registered listener for event: ${event}`);
      domListeners[event] = callback;
    },
    querySelectorAll: (selector) => {
      console.log(`[DOM] querySelectorAll called for: ${selector}`);
      return { forEach: () => {} };
    },
    getElementById: (id) => {
      console.log(`[DOM] getElementById called for: ${id}`);
      return {
        addEventListener: () => {},
        classList: { toggle: () => {} },
        value: '',
      };
    },
  },
  navigator: {
    geolocation: {},
  },
};

globalMock.window = globalMock;

// Run the script
try {
  const script = new vm.Script(jsCode, { filename: 'dist-inlined.js' });
  const context = vm.createContext(globalMock);
  script.runInContext(context);
  console.log('Script execution finished successfully without synchronous top-level errors.');
  
  // Trigger DOMContentLoaded
  if (domListeners['DOMContentLoaded']) {
    console.log('\n--- Simulating DOMContentLoaded ---');
    domListeners['DOMContentLoaded']();
  } else {
    console.log('\n[Warning] DOMContentLoaded listener was not registered!');
  }
  
  // Keep process alive to see async console.log/errors
  console.log('Waiting 6 seconds for async operations to complete...');
  setTimeout(() => {
    console.log('--- DIAGNOSTIC END ---');
  }, 6000);
} catch (err) {
  console.error('\n--- RUNTIME/SYNTAX ERROR DETECTED ---');
  console.error(err);
}
