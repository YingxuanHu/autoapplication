import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readRepoFile(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("application workspace constrains long job content within its shared grid", () => {
  const workspaceSource = readRepoFile("src/components/applications/workspace-client.tsx");
  const assistantSource = readRepoFile("src/components/applications/job-assistant.tsx");

  assert.match(workspaceSource, /grid min-w-0 items-start gap-4/);
  assert.match(workspaceSource, /grid min-w-0 content-start gap-4 self-start sm:gap-5/g);
  assert.match(workspaceSource, /surface-panel min-w-0 p-3\.5 sm:p-5/);
  assert.match(assistantSource, /surface-panel min-w-0 relative overflow-hidden/);
});
