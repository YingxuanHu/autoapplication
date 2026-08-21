import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5432/postgres";

let modulePromise: Promise<typeof import("../src/lib/ingestion/pipeline")> | null =
  null;
function loadPipeline() {
  modulePromise ??= import("../src/lib/ingestion/pipeline");
  return modulePromise;
}

// Guards the fix for the "transient 429/5xx wipes a whole source" bug: a
// full-snapshot fetch that errored (empty jobs + metadata.error) must NOT
// trigger freshness removal, while a genuine exhausted empty board still does.
test("errored full-snapshot fetch never runs freshness removal", async () => {
  const { shouldRunFreshnessRemovalFor } = await loadPipeline();
  assert.equal(
    shouldRunFreshnessRemovalFor({
      freshnessMode: "FULL_SNAPSHOT",
      limit: undefined,
      fetchExhausted: true,
      fetchHadError: true,
    }),
    false
  );
});

test("clean exhausted full snapshot removes when the source has no prior mappings", async () => {
  const { shouldRunFreshnessRemovalFor } = await loadPipeline();
  assert.equal(
    shouldRunFreshnessRemovalFor({
      freshnessMode: "FULL_SNAPSHOT",
      limit: undefined,
      fetchExhausted: true,
      fetchHadError: false,
      fetchedCount: 0,
      existingActiveMappingCount: 0,
    }),
    true
  );
});

test("empty, collapsed, and resumed snapshots preserve existing mappings", async () => {
  const { shouldRunFreshnessRemovalFor } = await loadPipeline();
  const base = {
    freshnessMode: "FULL_SNAPSHOT" as const,
    limit: undefined,
    fetchExhausted: true,
    fetchHadError: false,
  };

  assert.equal(
    shouldRunFreshnessRemovalFor({
      ...base,
      fetchedCount: 0,
      existingActiveMappingCount: 449,
    }),
    false
  );
  assert.equal(
    shouldRunFreshnessRemovalFor({
      ...base,
      fetchedCount: 22,
      existingActiveMappingCount: 223,
    }),
    false
  );
  assert.equal(
    shouldRunFreshnessRemovalFor({
      ...base,
      fetchedCount: 500,
      existingActiveMappingCount: 500,
      startingCheckpoint: { offset: 1_000 },
    }),
    false
  );
});

test("bounded (limited) or unexhausted or incremental fetches never remove", async () => {
  const { shouldRunFreshnessRemovalFor } = await loadPipeline();
  // A limited fetch is a partial view, not a snapshot.
  assert.equal(
    shouldRunFreshnessRemovalFor({
      freshnessMode: "FULL_SNAPSHOT",
      limit: 50,
      fetchExhausted: true,
      fetchHadError: false,
    }),
    false
  );
  // Not fully paginated.
  assert.equal(
    shouldRunFreshnessRemovalFor({
      freshnessMode: "FULL_SNAPSHOT",
      limit: undefined,
      fetchExhausted: false,
      fetchHadError: false,
    }),
    false
  );
  // Incremental connectors never do snapshot removal.
  assert.equal(
    shouldRunFreshnessRemovalFor({
      freshnessMode: "INCREMENTAL",
      limit: undefined,
      fetchExhausted: true,
      fetchHadError: false,
    }),
    false
  );
});
