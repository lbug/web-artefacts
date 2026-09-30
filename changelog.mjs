// Keeps CHANGELOG.md and the GitHub releases in step.
//   node changelog.mjs release        run by `npm version`: turns "## Unreleased" into the
//                                     new version's section, dated today
//   node changelog.mjs notes <1.2.3>  prints that version's section (the release notes)

import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./CHANGELOG.md", import.meta.url);
const changelog = readFileSync(file, "utf8");
const [command, version] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The text under `## <name>`, up to the next section; null if there is no such section. */
function section(name) {
  const heading = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( .*)?$`, "m").exec(changelog);
  if (!heading) return null;
  const rest = changelog.slice(heading.index + heading[0].length);
  const end = rest.search(/^## /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

if (command === "release") {
  const { version: next } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  if (!section("Unreleased")) fail('CHANGELOG.md: describe the changes under "## Unreleased" before releasing.');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(file, changelog.replace(/^## Unreleased$/m, `## Unreleased\n\n## ${next} - ${date}`));
} else if (command === "notes" && version) {
  const notes = section(version);
  if (!notes) fail(`CHANGELOG.md has no section for ${version}.`);
  console.log(notes);
} else {
  fail("Usage: node changelog.mjs release | notes <version>");
}
