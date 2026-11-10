// Both overrides are retained for regression checks against older releases.
const script = process.env.BOSS_TEST_SCRIPT
  || (process.env.BOSS_SCRIPT_VERSION ? `BOSS直聘 海投助手（AI版）-${process.env.BOSS_SCRIPT_VERSION}.user.js` : 'extension/helper.js');
export const SCRIPT = new URL('../' + script, import.meta.url);
