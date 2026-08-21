/**
 * Sanity tests for the Oracle Cloud HCM connector — locks in the URL pattern,
 * tenant validation, and the connector key shape.
 *
 * Oracle Cloud HCM is the single biggest ATS we did NOT poll directly until
 * this connector was added. Major NA employers (retailers, healthcare
 * systems, universities, governments, manufacturers) use it. If any of these
 * basics regress, all those tenants silently stop producing jobs.
 */
import { describe, it } from "node:test";
import { deepEqual, strictEqual, throws } from "node:assert";

import { createOracleCloudConnector } from "../src/lib/ingestion/connectors/oraclecloud";

describe("createOracleCloudConnector — sanity", () => {
  it("builds a connector with key + sourceName encoding the tenant", () => {
    const connector = createOracleCloudConnector({
      tenant: "ejov.fa.ca2.oraclecloud.com",
    });
    strictEqual(connector.key, "oraclecloud:ejov.fa.ca2:cx");
    strictEqual(connector.sourceName, "OracleCloud:ejov.fa.ca2");
    strictEqual(connector.sourceTier, "TIER_2");
  });

  it("respects a custom site identifier", () => {
    const connector = createOracleCloudConnector({
      tenant: "fa-exhh-saasfaprod1.fa.ocs.oraclecloud.com",
      site: "CX_2",
    });
    strictEqual(
      connector.key,
      "oraclecloud:fa-exhh-saasfaprod1.fa.ocs:cx_2"
    );
  });

  it("rejects non-oraclecloud.com tenants", () => {
    throws(
      () =>
        createOracleCloudConnector({
          // Looks plausible but wrong domain
          tenant: "ejov.fa.ca2.example.com",
        }),
      /invalid tenant host/i
    );
  });

  it("rejects empty / whitespace tenants", () => {
    throws(
      () => createOracleCloudConnector({ tenant: "" }),
      /requires a `tenant` host/i
    );
    throws(
      () => createOracleCloudConnector({ tenant: "   " }),
      /requires a `tenant` host/i
    );
  });

  it("normalizes tenant casing for the connector key", () => {
    const connector = createOracleCloudConnector({
      tenant: "EJOV.fa.CA2.oraclecloud.com",
    });
    strictEqual(connector.key, "oraclecloud:ejov.fa.ca2:cx");
  });

  it("keeps a checkpoint when the configured page cap stops a partial snapshot", async () => {
    const originalFetch = globalThis.fetch;
    const requestedOffsets: number[] = [];
    globalThis.fetch = async (url) => {
      const finder = new URL(String(url)).searchParams.get("finder") ?? "";
      const offset = Number(/offset=(\d+)/.exec(finder)?.[1]);
      requestedOffsets.push(offset);
      const requisitionList = Array.from({ length: 2 }, (_, index) => ({
        Id: String(offset + index + 1),
        Title: `Job ${offset + index + 1}`,
        PrimaryLocation: "Toronto, Ontario",
      }));
      return new Response(
        JSON.stringify({
          items: [{ requisitionList, TotalJobsCount: 5 }],
        }),
        { status: 200 }
      );
    };

    try {
      const connector = createOracleCloudConnector({
        tenant: "ejov.fa.ca2.oraclecloud.com",
        limitPerPage: 2,
        maxPages: 2,
      });
      const checkpoints: unknown[] = [];
      const result = await connector.fetchJobs({
        now: new Date("2026-08-21T00:00:00.000Z"),
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      });

      strictEqual(result.jobs.length, 4);
      strictEqual(result.exhausted, false);
      deepEqual(result.checkpoint, { offset: 4 });
      deepEqual(checkpoints, [{ offset: 2 }, { offset: 4 }]);
      deepEqual(requestedOffsets, [0, 2]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks a fully fetched Oracle snapshot exhausted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const finder = new URL(String(url)).searchParams.get("finder") ?? "";
      const offset = Number(/offset=(\d+)/.exec(finder)?.[1]);
      const count = offset === 0 ? 2 : 1;
      return new Response(
        JSON.stringify({
          items: [
            {
              requisitionList: Array.from({ length: count }, (_, index) => ({
                Id: String(offset + index + 1),
                Title: `Job ${offset + index + 1}`,
                PrimaryLocation: "Toronto, Ontario",
              })),
              TotalJobsCount: 3,
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const connector = createOracleCloudConnector({
        tenant: "ejov.fa.ca2.oraclecloud.com",
        limitPerPage: 2,
        maxPages: 2,
      });
      const result = await connector.fetchJobs({
        now: new Date("2026-08-21T00:00:00.000Z"),
      });

      strictEqual(result.jobs.length, 3);
      strictEqual(result.exhausted, true);
      strictEqual(result.checkpoint, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
