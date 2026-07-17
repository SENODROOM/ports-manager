#!/usr/bin/env node
'use strict';

require('../src/cli').main().catch((error) => {
  console.error(`ports-manager: ${error.message}`);
  if (process.env.PORTS_MANAGER_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
