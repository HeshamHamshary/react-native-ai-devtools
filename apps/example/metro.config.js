const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');
const { withMetroConfig } = require('react-native-monorepo-config');
const mockApi = require('./mockApi');

const root = path.resolve(__dirname, '../..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = withMetroConfig(getDefaultConfig(__dirname), {
  root,
  dirname: __dirname,
  conditions: ['react-native-agent-devtools-source'],
});

// The example app's fake backend lives on the dev server so it works on
// simulators, emulators and LAN devices without another process.
config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) =>
    req.url && req.url.startsWith('/example-api/') ? mockApi(req, res) : middleware(req, res, next),
};

module.exports = config;
