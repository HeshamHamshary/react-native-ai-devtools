/**
 * Expo config plugin for react-native-agent-devtools.
 *
 * The native module is autolinked like any React Native library; nothing has to be
 * registered by hand. This plugin only adds what a development build needs to reach
 * the devtools server from a physical iPhone over Wi-Fi (`--lan`): the Local Network
 * usage description (iOS asks for permission on first connection). It is added only
 * when the app doesn't already have one (expo-dev-client brings its own).
 *
 * Expo Go cannot load this library's native module: use a development build.
 */
const path = require('path');

const DEFAULT_DESCRIPTION = 'Development builds connect to developer tools running on your computer.';

function withAgentDevTools(config, props = {}) {
  const { withInfoPlist } = require('@expo/config-plugins');
  warnWithoutDevClient(config);
  return withInfoPlist(config, (c) => {
    if (props.localNetwork !== false && !c.modResults.NSLocalNetworkUsageDescription) {
      c.modResults.NSLocalNetworkUsageDescription = props.localNetworkUsageDescription || DEFAULT_DESCRIPTION;
    }
    return c;
  });
}

function warnWithoutDevClient(config) {
  const root = config._internal && config._internal.projectRoot;
  if (!root) return;
  try {
    const pkg = require(path.join(root, 'package.json'));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (!deps['expo-dev-client']) {
      console.warn(
        '[react-native-agent-devtools] expo-dev-client is not installed. Expo Go cannot load this library\'s native module; build a development build (npx expo run:ios / run:android).',
      );
    }
  } catch {
    // no package.json to inspect
  }
}

const pkg = require('../package.json');
let plugin = withAgentDevTools;
try {
  plugin = require('@expo/config-plugins').createRunOncePlugin(withAgentDevTools, pkg.name, pkg.version);
} catch {
  // @expo/config-plugins is only present in Expo projects; the plain function still works.
}
module.exports = plugin;
module.exports.withAgentDevTools = withAgentDevTools;
