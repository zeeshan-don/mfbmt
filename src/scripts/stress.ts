import { randomUUID } from "node:crypto";
import { rawDb } from "../lib/db-base";
import { db } from "../lib/db";
import { runWithTenant } from "../lib/tenant";
import {
  InsufficientStockError,
  reserveQuotationStock,
} from "../lib/inventory/reservations";
import { claimJob, completeJob, enqueueJob } from "../lib/workflow/jobs";
import { sendOutboundOnce } from "../lib/outbound/messages";
import { JOB_TYPES } from "../lib/constants";

/**
 * Isolated load/concurrency harness.
 *
 * It deliberately refuses to run against anything that is not clearly a test or
 * stress database. It creates synthetic records only, measures real PostgreSQL
 * behaviour, and deletes its own tenant at the end.
 *
 * This is not a browser or full RFQ-pipeline load test. It measures the three
 * concurrency-critical paths: stock reservation, the durable job queue and the
 * outbound duplicate-send guard.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";
const clearlyIsolated =
  /(?:^|[/?&])(?:[^/?&]*)(?:_test|_stress)(?:\?|$|&)/i.test(databaseUrl) ||
  /(?:^|[/?&])mfbmt_(?:test|stress)(?:\?|&|$)/i.test(databaseUrl);
if (process.env.NODE_ENV === "production" || /prod/i.test(databaseUrl) || !clearlyIsolated) {
  console.error(
    "Refusing to run the stress harness. DATABASE_URL must point at an isolated *_test or *_stress database and NODE_ENV must not be production.",
  );
  process.exit(1);
}

const RUN = randomUUID().slice(0, 8);
const orgSlug = `stress-${RUN}`;
const metrics: Record<string, unknown> = { database: "isolated test database", run: RUN };

const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createProductAndQuote(input: {
  organizationId: string;
  label: string;
  stock: number;
  needed: number;
  locations?: number;
}) {
  const product = await db.product.create({
    data: {
      organizationId: input.organizationId,
      sku: `STRESS-${RUN}-${input.label}`,
      name: `Stress product ${input.label}`,
      category: "Pipes",
      unit: "pcs",
    },
  });
  const locationCount = input.locations ?? 2;
  const perLocation = input.stock / locationCount;
  for (let index = 0; index < locationCount; index += 1) {
    const location = await db.inventoryLocation.create({
      data: {
        organizationId: input.organizationId,
        code: `STRESS-${RUN}-${input.label}-${index}`,
        name: `Stress location ${index}`,
      },
    });
    await db.inventoryStock.create({
      data: {
        organizationId: input.organizationId,
        productId: product.id,
        locationId: location.id,
        quantityOnHand: perLocation,
      },
    });
  }

  const enquiry = await db.enquiry.create({
    data: {
      organizationId: input.organizationId,
      publicRef: `STRESS-${RUN}-${input.label}`,
      channel: "MANUAL",
      rawText: "synthetic stress enquiry",
      status: "APPROVED",
    },
  });
  const item = await db.enquiryItem.create({
    data: {
      organizationId: input.organizationId,
      enquiryId: enquiry.id,
      description: `Stress line ${input.label}`,
      category: "Pipes",
      quantity: input.needed,
      unit: "pcs",
      matchedProductId: product.id,
      quantityFromStock: input.needed,
      quantityToSource: 0,
    },
  });
  const quotation = await db.customerQuotation.create({
    data: {
      organizationId: input.organizationId,
      enquiryId: enquiry.id,
      quoteNumber: `STRESS-${RUN}-${input.label}`,
      version: 1,
      customerName: "Synthetic Stress Customer",
      currency: "AED",
      subtotal: 10 * input.needed,
      total: 10 * input.needed,
      status: "AWAITING_APPROVAL",
      items: {
        create: [
          {
            organizationId: input.organizationId,
            description: `Stress line ${input.label}`,
            quantity: input.needed,
            unit: "pcs",
            unitPrice: 10,
            lineTotal: 10 * input.needed,
            priceStatus: "PRICED",
            stockQuantity: input.needed,
            enquiryItemId: item.id,
          },
        ],
      },
    },
  });
  return { product, item, quotation };
}

async function reservationLoad(organizationId: string) {
  const fixtures = [];
  for (let index = 0; index < 30; index += 1) {
    fixtures.push(
      await createProductAndQuote({
        organizationId,
        label: `rfq-${index}`,
        stock: 12,
        needed: 8,
      }),
    );
  }
  const started = nowMs();
  const results = await Promise.allSettled(
    fixtures.map((fixture) =>
      reserveQuotationStock({ organizationId, quotationId: fixture.quotation.id }),
    ),
  );
  const elapsedMs = nowMs() - started;
  const succeeded = results.filter((result) => result.status === "fulfilled").length;
  const failed = results.length - succeeded;
  if (succeeded !== 30 || failed !== 0) {
    throw new Error(`30 concurrent independent reservations expected 30 successes, got ${succeeded}/${failed}.`);
  }
  return { concurrentQuotations: 30, succeeded, failed, elapsedMs, perSecond: Number(((30 / Math.max(1, elapsedMs)) * 1000).toFixed(1)) };
}

async function contentionLoad(organizationId: string) {
  const { product, item } = await createProductAndQuote({
    organizationId,
    label: "contended",
    stock: 10,
    needed: 2,
  });
  const quotes = [];
  for (let index = 0; index < 10; index += 1) {
    quotes.push(
      await db.customerQuotation.create({
        data: {
          organizationId,
          enquiryId: (
            await db.enquiry.create({
              data: {
                organizationId,
                publicRef: `STRESS-${RUN}-contend-${index}`,
                channel: "MANUAL",
                rawText: "contended",
                status: "APPROVED",
              },
            })
          ).id,
          quoteNumber: `STRESS-${RUN}-contend-${index}`,
          version: 1,
          customerName: "Contention Customer",
          currency: "AED",
          subtotal: 20,
          total: 20,
          status: "AWAITING_APPROVAL",
          items: {
            create: [
              {
                organizationId,
                description: "Contended line",
                quantity: 2,
                unit: "pcs",
                unitPrice: 10,
                lineTotal: 20,
                priceStatus: "PRICED",
                stockQuantity: 2,
                enquiryItemId: item.id,
              },
            ],
          },
        },
      }),
    );
  }

  const started = nowMs();
  const results = await Promise.allSettled(
    quotes.map((quotation) => reserveQuotationStock({ organizationId, quotationId: quotation.id })),
  );
  const elapsedMs = nowMs() - started;
  const succeeded = results.filter((result) => result.status === "fulfilled").length;
  const rejected = results.filter((result) => result.status === "rejected");
  if (succeeded !== 5 || rejected.length !== 5) {
    throw new Error(`Contended reservations expected 5 success/5 insufficient, got ${succeeded}/${rejected.length}.`);
  }
  if (!rejected.every((result) => result.reason instanceof InsufficientStockError)) {
    throw new Error("A contended reservation failed for a reason other than insufficient stock.");
  }
  const stock = await rawDb.inventoryStock.aggregate({
    where: { organizationId, productId: product.id },
    _sum: { quantityReserved: true },
  });
  if ((stock._sum.quantityReserved ?? 0) !== 10) {
    throw new Error(`Reserved stock must be exactly 10, got ${stock._sum.quantityReserved}.`);
  }
  return {
    concurrentQuotations: 10,
    availableUnits: 10,
    requestedUnitsEach: 2,
    succeeded,
    insufficient: rejected.length,
    finalReservedUnits: stock._sum.quantityReserved,
    elapsedMs,
  };
}

async function jobLoad(organizationId: string) {
  const queuedAt = nowMs();
  await runWithTenant({ organizationId, source: "internal" }, async () => {
    for (let index = 0; index < 300; index += 1) {
      await enqueueJob({
        type: JOB_TYPES.OPS_CHECK,
        payload: { index },
        idempotencyKey: `stress:${RUN}:job:${index}`,
      });
    }
  });
  const enqueueMs = nowMs() - queuedAt;

  const started = nowMs();
  const worker = async (workerId: string) => {
    let completed = 0;
    for (;;) {
      const job = await claimJob(workerId);
      if (!job) break;
      if (await completeJob(job.id, workerId, "stress")) completed += 1;
    }
    return completed;
  };
  const completed = (await Promise.all(
    Array.from({ length: 4 }, (_, index) => worker(`stress-${RUN}-${index}`)),
  )).reduce((sum, value) => sum + value, 0);
  const elapsedMs = nowMs() - started;
  if (completed !== 300) throw new Error(`Expected 300 completed jobs, got ${completed}.`);
  return { enqueued: 300, completed, workers: 4, enqueueMs, claimCompleteMs: elapsedMs };
}

async function outboundLoad(organizationId: string) {
  const keys = Array.from({ length: 60 }, (_, index) => `stress:${RUN}:outbound:${index}`);
  let providerCalls = 0;
  const started = nowMs();
  await Promise.all(
    keys.map((operationKey) =>
      Promise.all(
        Array.from({ length: 2 }, () =>
          sendOutboundOnce(
            {
              operationKey,
              kind: "STRESS",
              channel: "EMAIL",
              recipient: "synthetic@example.com",
              body: "synthetic load message",
              maxAttempts: 2,
            },
            async () => {
              providerCalls += 1;
              await sleep(5);
              return { outcome: "SENT", providerMessageId: `stress-${operationKey}` };
            },
          ),
        ),
      ),
    ),
  );
  const elapsedMs = nowMs() - started;
  const rows = await rawDb.outboundMessage.findMany({
    where: { organizationId, operationKey: { in: keys } },
    select: { status: true },
  });
  const sent = rows.filter((row) => row.status === "SENT").length;
  if (providerCalls !== 60 || sent !== 60) {
    throw new Error(`Outbound duplicate guard failed: ${providerCalls} provider calls, ${sent} SENT rows.`);
  }
  return {
    messages: 60,
    concurrentDuplicateAttempts: 120,
    providerCalls,
    duplicateProviderCalls: providerCalls - 60,
    sentRows: sent,
    elapsedMs,
  };
}

async function unknownOutcomeLoad(organizationId: string) {
  const keys = Array.from({ length: 5 }, (_, index) => `stress:${RUN}:unknown:${index}`);
  let providerCalls = 0;
  let blockedRetries = 0;
  for (const operationKey of keys) {
    const first = await sendOutboundOnce(
      {
        operationKey,
        kind: "STRESS",
        channel: "EMAIL",
        recipient: "synthetic@example.com",
        body: "timeout simulation",
        maxAttempts: 2,
      },
      async () => {
        providerCalls += 1;
        return { outcome: "UNKNOWN", error: "simulated provider timeout" };
      },
    );
    if (first.status !== "UNCERTAIN") throw new Error("Simulated timeout was not recorded as uncertain.");
    const second = await sendOutboundOnce(
      {
        operationKey,
        kind: "STRESS",
        channel: "EMAIL",
        recipient: "synthetic@example.com",
        body: "timeout simulation",
        maxAttempts: 2,
      },
      async () => {
        providerCalls += 1;
        return { outcome: "SENT" };
      },
    );
    if (second.status === "UNCERTAIN") blockedRetries += 1;
  }
  if (providerCalls !== 5 || blockedRetries !== 5) {
    throw new Error(`Unknown-outcome guard failed: ${providerCalls} calls, ${blockedRetries} blocked retries.`);
  }
  return { timeouts: 5, providerCalls, blockedAutomaticRetries: blockedRetries };
}

async function main() {
  const organization = await rawDb.organization.create({
    data: {
      slug: orgSlug,
      name: `Synthetic Stress ${RUN}`,
      status: "ACTIVE",
      country: "AE",
      timezone: "Asia/Dubai",
      defaultCurrency: "AED",
    },
  });

  try {
    // The queue claim is intentionally global across tenants. Clear only this
    // disposable database's pending queue so the 300-job measurement is exact.
    await rawDb.backgroundJob.deleteMany({ where: { status: { in: ["QUEUED", "PROCESSING"] } } });
    await runWithTenant({ organizationId: organization.id, source: "explicit" }, async () => {
      metrics.reservations30 = await reservationLoad(organization.id);
      metrics.contention = await contentionLoad(organization.id);
      metrics.jobs = await jobLoad(organization.id);
      metrics.outbound = await outboundLoad(organization.id);
      metrics.unknownOutcome = await unknownOutcomeLoad(organization.id);
    });
    metrics.server = {
      node: process.version,
      platform: process.platform,
      database: "PostgreSQL (isolated Docker test database)",
    };
    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    await rawDb.organization.delete({ where: { id: organization.id } }).catch(() => undefined);
    await rawDb.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
