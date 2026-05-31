const { withProjectBuildGradle } = require('expo/config-plugins');

/**
 * Notifee ships its Android `core` AAR locally inside node_modules instead of a
 * remote maven repo. Expo `prebuild --clean` regenerates android/ without a repo
 * pointing at it, so Gradle can't resolve `app.notifee:core:+`.
 *
 * This plugin injects that maven repo into the root project's `allprojects`
 * block using Gradle's `$rootDir` (= android/), which resolves correctly for
 * every subproject — unlike a relative path in extraMavenRepos.
 */
const MARKER = '// notifee-local-maven-repo';
const REPO = `        maven { url("$rootDir/../node_modules/@notifee/react-native/android/libs") } ${MARKER}`;

module.exports = function withNotifeeMaven(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('with-notifee-maven: expected groovy build.gradle');
    }
    let contents = cfg.modResults.contents;
    if (contents.includes(MARKER)) return cfg;

    // Insert into the allprojects { repositories { ... } } block.
    const anchor = /allprojects\s*\{\s*repositories\s*\{/;
    if (!anchor.test(contents)) {
      throw new Error('with-notifee-maven: allprojects.repositories block not found');
    }
    contents = contents.replace(anchor, (m) => `${m}\n${REPO}`);
    cfg.modResults.contents = contents;
    return cfg;
  });
};
