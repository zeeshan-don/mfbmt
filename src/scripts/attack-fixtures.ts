import { rawDb } from "../lib/db-base";
import { db } from "../lib/db";
import { runWithTenant } from "../lib/tenant";
import { reserveQuotationStock } from "../lib/inventory/reservations";
import { assertIsolatedDatabaseUrl, scriptDatabaseUrl } from "./safety";

/**
 * Synthetic attack-test environment. It only ever creates or deletes
 * organizations whose slug starts with "attack-"; no real tenant is touched.
 *
 * Commands:
 *   reset    delete synthetic organizations, then recreate fresh fixtures
 *   seed     recreate fresh fixtures
 *   inspect  counts for synthetic organizations
 *   race     two concurrent reservations for the exact seeded stock
 *   cleanup  delete only synthetic organizations
 */
const PREFIX = "attack-";
const MFBMT = "attack-mfbmt";
const OGS = "attack-ogs";

try {
  assertIsolatedDatabaseUrl(scriptDatabaseUrl(), "attack-fixtures");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function cleanup() {
  const removed = await rawDb.organization.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  console.log(`[attack] removed ${removed.count} synthetic organization(s).`);
}

async function makeTenant(input: { id: string; slug: string; name: string; procurementProfile: "GENERAL" | "INDUSTRIAL" }) {
  const organization = await rawDb.organization.create({
    data: {
      id: input.id,
      slug: input.slug,
      name: input.name,
      country: "AE",
      defaultCurrency: "AED",
      procurementProfile: input.procurementProfile,
      status: "ACTIVE",
    },
  });

  return runWithTenant({ organizationId: organization.id, source: "explicit" }, async () => {
    const locations = await Promise.all(
      [
        { code: `${input.slug}-WH1`, name: "Warehouse 1" },
        { code: `${input.slug}-WH2`, name: "Warehouse 2" },
      ].map((location) => db.inventoryLocation.create({ data: location })),
    );
    const product = await db.product.create({
      data: {
        sku: `${input.slug}-PIPE-4IN`,
        name: "Synthetic carbon steel pipe 4 inch SCH 40",
        category: "Pipes",
        size: "4 inch",
        material: "Carbon steel",
        standard: "ASTM A106",
        unit: "pcs",
        isDemo: true,
      },
    });
    await db.inventoryStock.createMany({
      data: [
        { organizationId: organization.id, productId: product.id, locationId: locations[0].id, quantityOnHand: 2 },
        { organizationId: organization.id, productId: product.id, locationId: locations[1].id, quantityOnHand: 2 },
      ],
    });
    const supplier = await db.supplier.create({
      data: {
        name: `${input.name} Synthetic Supplier`,
        email: `supplier@${input.slug}.example.test`,
        status: "ACTIVE",
        isDemo: true,
      },
    });
    const enquiry = await db.enquiry.create({
      data: {
        publicRef: `ENQ-${input.slug.toUpperCase()}-001`,
        channel: "MANUAL",
        customerName: "Synthetic Attack Customer",
        customerEmail: "customer@example.test",
        rawText: "4 pcs carbon steel pipe 4 inch SCH 40 ASTM A106",
        status: "AWAITING_APPROVAL",
        isDemo: true,
        items: {
          create: [
            {
              lineNo: 1,
              description: "Carbon steel pipe 4 inch SCH 40 ASTM A106",
              category: "Pipes",
              size: "4 inch",
              material: "Carbon steel",
              standard: "ASTM A106",
              quantity: 4,
              unit: "pcs",
              quantityFromStock: 4,
              quantityToSource: 0,
              inventoryStatus: "AVAILABLE",
              matchedProductId: product.id,
            },
          ],
        },
      },
      include: { items: true },
    });
    const quotation = await db.customerQuotation.create({
      data: {
        enquiryId: enquiry.id,
        quoteNumber: `QT-${input.slug.toUpperCase()}-001`,
        customerName: "Synthetic Attack Customer",
        currency: "AED",
        subtotal: 400,
        total: 400,
        status: "AWAITING_APPROVAL",
        isDemo: true,
        items: {
          create: [
            {
              description: "Carbon steel pipe 4 inch SCH 40 ASTM A106",
              quantity: 4,
              unit: "pcs",
              unitPrice: 100,
              lineTotal: 400,
              priceStatus: "PRICED",
              stockQuantity: 4,
              enquiryItemId: enquiry.items[0].id,
            },
          ],
        },
      },
    });
    await db.approval.create({
      data: {
        type: "CUSTOMER_QUOTATION",
        entityType: "CustomerQuotation",
        entityId: quotation.id,
        enquiryId: enquiry.id,
        status: "PENDING",
        requestedBy: "attack-fixture",
      },
    });
    await rawDb.outboundMessage.create({
      data: {
        organizationId: organization.id,
        operationKey: `${PREFIX}unknown-${input.id}`,
        kind: "SUPPLIER_RFQ",
        channel: "EMAIL",
        recipient: supplier.email ?? "supplier@example.test",
        subject: "Synthetic UNKNOWN outbound message",
        body: "Synthetic body. No provider was called.",
        status: "UNKNOWN",
        attempts: 1,
        maxAttempts: 4,
        lastError: "Synthetic timeout: provider may have accepted the message.",
        relatedType: "Supplier",
        relatedId: supplier.id,
      },
    });
    return { organization, product, supplier, enquiry, quotation, locations };
  });
}

async function seed() {
  await cleanup();
  const mfbmt = await makeTenant({ id: MFBMT, slug: MFBMT, name: "Attack MFBMT", procurementProfile: "GENERAL" });
  const ogs = await makeTenant({ id: OGS, slug: OGS, name: "Attack OGS", procurementProfile: "INDUSTRIAL" });
  console.log(`[attack] seeded ${MFBMT} and ${OGS}.`);
  console.log(`[attack] MFBMT quotation=${mfbmt.quotation.id} OGS quotation=${ogs.quotation.id}`);
  console.log("[attack] synthetic UNKNOWN outbound rows are visible at /observability.");
}

async function inspect() {
  const organizations = await rawDb.organization.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });
  for (const organization of organizations) {
    const [products, stock, reservations, outbound, jobs, enquiries, approvals] = await Promise.all([
      rawDb.product.count({ where: { organizationId: organization.id } }),
      rawDb.inventoryStock.findMany({ where: { organizationId: organization.id }, select: { quantityOnHand: true, quantityReserved: true } }),
      rawDb.stockReservation.findMany({ where: { organizationId: organization.id }, select: { status: true, quantity: true, quotationId: true } }),
      rawDb.outboundMessage.groupBy({ by: ["status"], where: { organizationId: organization.id }, _count: true }),
      rawDb.backgroundJob.groupBy({ by: ["status"], where: { organizationId: organization.id }, _count: true }),
      rawDb.enquiry.count({ where: { organizationId: organization.id } }),
      rawDb.approval.count({ where: { organizationId: organization.id } }),
    ]);
    console.log(
      JSON.stringify(
        {
          slug: organization.slug,
          products,
          stock: stock.map((row) => ({ onHand: row.quantityOnHand, reserved: row.quantityReserved })),
          reservations,
          outbound: outbound.map((row) => ({ status: row.status, count: row._count })),
          jobs: jobs.map((row) => ({ status: row.status, count: row._count })),
          enquiries,
          approvals,
        },
        null,
        2,
      ),
    );
  }
  if (organizations.length === 0) console.log("[attack] no synthetic organizations; run attack:seed first.");
}

async function race() {
  const quotation = await rawDb.customerQuotation.findFirst({
    where: { organizationId: MFBMT, quoteNumber: "QT-ATTACK-MFBMT-001" },
    select: { id: true },
  });
  if (!quotation) throw new Error("Run attack:seed first.");
  const results = await runWithTenant({ organizationId: MFBMT, source: "explicit" }, () =>
    Promise.allSettled([
      reserveQuotationStock({ organizationId: MFBMT, quotationId: quotation.id }),
      reserveQuotationStock({ organizationId: MFBMT, quotationId: quotation.id }),
    ]),
  );
  console.log(
    JSON.stringify(
      results.map((result) =>
        result.status === "fulfilled"
          ? { status: "fulfilled", created: result.value.created.length, duplicates: result.value.duplicates.length }
          : { status: "rejected", error: result.reason instanceof Error ? result.reason.message : String(result.reason) },
      ),
      null,
      2,
    ),
  );
  await inspect();
}

async function main() {
  const command = (process.argv[2] ?? "inspect").toLowerCase();
  switch (command) {
    case "seed":
      await seed();
      break;
    case "reset":
      await seed();
      break;
    case "inspect":
      await inspect();
      break;
    case "race":
      await race();
      break;
    case "cleanup":
      await cleanup();
      break;
    default:
      console.error(`Unknown command "${command}". Use seed, reset, inspect, race or cleanup.`);
      process.exitCode = 1;
  }
  await rawDb.$disconnect();
}

main().catch(async (error) => {
  console.error(`[attack] ${error instanceof Error ? error.message : String(error)}`);
  await rawDb.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
