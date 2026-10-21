#!/usr/bin/env node
// Published builds run compiled JS from lib/. In the monorepo, `yarn server`
// runs src/cli.ts directly with Node's type stripping.
import('../lib/cli.js');
