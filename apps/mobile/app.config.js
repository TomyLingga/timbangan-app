// Extends app.json with the Firebase file of the Android build, when there is one.
//
// google-services.json is looked for, in this order:
//   1. the path in GOOGLE_SERVICES_JSON (a file kept outside git, e.g. ../../.data/firebase/google-services.json);
//   2. ./google-services.json in this folder (ignored by git, see .gitignore).
// The file must never be committed: the repository is public. Its content is never read or printed here.
// Without the file the build still works: the app gets no push token and skips registration (extra.pushEnabled).

const fs = require("node:fs");
const path = require("node:path");

function googleServicesFile() {
  const fromEnv = process.env.GOOGLE_SERVICES_JSON;
  if (fromEnv) {
    const resolved = path.resolve(__dirname, fromEnv);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`GOOGLE_SERVICES_JSON points to a file that does not exist: ${resolved}`);
  }
  const local = path.join(__dirname, "google-services.json");
  return fs.existsSync(local) ? "./google-services.json" : null;
}

module.exports = ({ config }) => {
  const file = googleServicesFile();
  return {
    ...config,
    android: { ...config.android, ...(file ? { googleServicesFile: file } : {}) },
    extra: { ...config.extra, pushEnabled: file !== null },
  };
};
