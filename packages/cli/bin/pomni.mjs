#!/usr/bin/env node
// `node:sqlite` is stable enough for our use but still emits an ExperimentalWarning on
// Node 22. Filter that one line rather than hiding every warning the user might need.
const defaults = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of defaults) listener(warning);
});

const { main } = await import('../dist/index.js');

process.exitCode = await main(process.argv);
