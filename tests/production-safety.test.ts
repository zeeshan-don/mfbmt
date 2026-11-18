import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { canonicalPhone, parseEmailAddress, isPrivateCategory } from "../src/lib/intake/identity";
import { ipIsPrivate, isSafePublicUrl, hostResolvesPublic } from "../src/lib/sourcing/pages";
import { encryptSecret, decryptSecret, tryDecryptSecret, verifyHmacSignature, hmacSignature, signPayload, verifySignedPayload } from "../src/lib/crypto";
import { passwordProblem } from "../src/lib/account";
import { validateSupplierResponse } from "../src/lib/workflow/supplierQuotes";
import { ingestInboundMessage } from "../src/lib/workflow/enquiry";
import { sendApprovedQuotation } from "../src/lib/workflow/quotations";
import { enqueueJob, claimJob, releaseExpiredJobs, retryJob } from "../src/lib/workflow/jobs";
import { hashPassword } from "../src/lib/auth";

beforeEach(async () => {
  await db.supplierOffer.deleteMany();
  await db.customerQuotationItem.deleteMany();
  await db.customerQuotation.deleteMany();
  await db.approval.deleteMany();
  await db.enquiryItem.deleteMany();
  await db.enquiry.deleteMany();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.contact.deleteMany();
  await db.excludedContact.deleteMany();
  await db.backgroundJob.deleteMany();
  await db.auditLog.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("contact identity", () => {
  it("normalizes UAE numbers written in different ways to one canonical value", () => {
    const expected = "+971501234567";
    expect(canonicalPhone("971501234567")).toBe(expected);
    expect(canonicalPhone("+971 50 123 4567")).toBe(expected);
    expect(canonicalPhone("0501234567")).toBe(expected);
    expect(canonicalPhone("00971501234567")).toBe(expected);
    expect(canonicalPhone("501234567")).toBe(expected);
  });

  it("extracts the real address from an email From header", () => {
    expect(parseEmailAddress('"Ahmed Khan" <Ahmed.Khan@Example.com>')).toBe("ahmed.khan@example.com");
    expect(parseEmailAddress("buyer@example.ae")).toBe("buyer@example.ae");
    expect(parseEmailAddress("not an address")).toBe("");
  });

  it("treats only family, personal and other as private", () => {
    expect(isPrivateCategory("FAMILY")).toBe(true);
    expect(isPrivateCategory("PERSONAL")).toBe(true);
    expect(isPrivateCategory("OTHER")).toBe(true);
    expect(isPrivateCategory("CUSTOMER")).toBe(false);
    expect(isPrivateCategory("TRUSTED_SUPPLIER")).toBe(false);
    expect(isPrivateCategory(null)).toBe(false);
  });

  it("never stores the body of an excluded email sender", async () => {
    await db.excludedContact.create({
      data: { identifier: "wife@example.com", category: "PERSONAL" },
    });
    const result = await ingestInboundMessage({
      channel: "EMAIL",
      externalMessageId: `mail-family-${randomUUID()}`,
      from: "Wife <Wife@Example.com>",
      subject: "Dinner",
      body: "Private family content that must not be stored",
    });
    expect(result.ignored).toBe(true);
    const message = await db.message.findUnique({ where: { id: result.messageId } });
    expect(message?.body ?? "").toBe("");
    expect(await db.enquiry.count()).toBe(0);
  });
});

describe("supplier page fetching (SSRF)", () => {
  it("blocks loopback, private ranges, link-local and credentials in URLs", () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "http://localhost:3000/",
      "http://10.1.2.3/",
      "http://192.168.1.10/",
      "http://172.20.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://user:pass@example.com/",
      "file:///etc/passwd",
    ]) {
      expect(isSafePublicUrl(url), url).toBe(false);
    }
    expect(isSafePublicUrl("https://example.com/catalogue")).toBe(true);
  });

  it("recognises IPv6 and IPv4-mapped private addresses", () => {
    expect(ipIsPrivate("::1")).toBe(true);
    expect(ipIsPrivate("::ffff:10.0.0.5")).toBe(true);
    expect(ipIsPrivate("fc00::1")).toBe(true);
    expect(ipIsPrivate("fe80::1")).toBe(true);
    expect(ipIsPrivate("8.8.8.8")).toBe(false);
    expect(ipIsPrivate("2606:4700::1111")).toBe(false);
  });

  it("refuses hostnames that resolve to a non-public network", async () => {
    expect(await hostResolvesPublic("localhost")).toBe(false);
    expect(await hostResolvesPublic("127.0.0.1")).toBe(false);
  });
});

describe("credential encryption", () => {
  it("round-trips an integration token", () => {
    const token = "EAAG-test-token-value";
    const sealed = encryptSecret(token);
    expect(sealed).not.toContain(token);
    expect(decryptSecret(sealed)).toBe(token);
  });

  it("surfaces a decryption failure instead of pretending the token is valid", () => {
    const sealed = encryptSecret("secret");
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    const result = tryDecryptSecret(tampered);
    expect(result.ok).toBe(false);
  });
});

describe("signatures and signed links", () => {
  it("accepts a valid Meta-style signature and rejects a forged one", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const header = hmacSignature("app-secret", body);
    expect(verifyHmacSignature("app-secret", body, header)).toBe(true);
    expect(verifyHmacSignature("app-secret", `${body} `, header)).toBe(false);
    expect(verifyHmacSignature("other-secret", body, header)).toBe(false);
    expect(verifyHmacSignature("app-secret", body, null)).toBe(false);
  });

  it("rejects an expired signed payload", () => {
    const expired = signPayload({ quotationId: "q1" }, -10);
    const result = verifySignedPayload(expired);
    expect(result.ok).toBe(false);
  });
});

describe("password policy", () => {
  it("requires length and a mix of letters and numbers", () => {
    expect(passwordProblem("short1")).toMatch(/at least/i);
    expect(passwordProblem("alllettersonly")).toMatch(/letters and numbers/i);
    expect(passwordProblem("Password12345")).toMatch(/easy to guess/i);
    expect(passwordProblem("Str0ng-Enough-2026")).toBeNull();
  });
});

describe("supplier response validation", () => {
  const base = { token: "t", unitPrice: 10, currency: "AED" };

  it("accepts a well-formed response", () => {
    expect(validateSupplierResponse(base)).toBeNull();
  });

  it("rejects a zero price, a bad currency and negative charges", () => {
    expect(validateSupplierResponse({ ...base, unitPrice: 0 })).toMatch(/unit price/i);
    expect(validateSupplierResponse({ ...base, currency: "AEDX" })).toMatch(/currency/i);
    expect(validateSupplierResponse({ ...base, shippingCost: -5 })).toMatch(/shipping/i);
    expect(validateSupplierResponse({ ...base, validityDays: 999 })).toMatch(/validity/i);
  });
});

describe("quotation release control", () => {
  it("refuses to release a quotation that still has an unpriced line", async () => {
    const owner = await db.user.create({
      data: {
        email: `owner-${randomUUID()}@example.com`,
        name: "Test Owner",
        passwordHash: await hashPassword("Str0ng-Enough-2026"),
        role: "OWNER",
      },
    });
    const enquiry = await db.enquiry.create({
      data: { publicRef: `Q-${randomUUID().slice(0, 8)}`, channel: "MANUAL", rawText: "x", status: "READY" },
    });
    const quotation = await db.customerQuotation.create({
      data: {
        enquiryId: enquiry.id,
        quoteNumber: `QT-${randomUUID().slice(0, 8)}`,
        customerName: "Customer",
        currency: "AED",
        status: "APPROVED",
        approvedById: owner.id,
        approvedAt: new Date(),
        items: {
          create: [
            {
              description: "Gate valve 1 inch SS316",
              quantity: 5,
              unit: "pcs",
              unitPrice: null,
              lineTotal: null,
              priceStatus: "UNPRICED",
            },
          ],
        },
      },
    });

    const result = await sendApprovedQuotation({
      quotationId: quotation.id,
      channel: "MANUAL",
      userId: owner.id,
      actorLabel: owner.name,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unpriced/i);
    const reloaded = await db.customerQuotation.findUnique({ where: { id: quotation.id } });
    expect(reloaded?.status).toBe("APPROVED");
    expect(reloaded?.sentAt).toBeNull();
  });
});

describe("durable job queue", () => {
  it("claims a job once so two workers cannot run it at the same time", async () => {
    const job = await enqueueJob({
      type: "EXTRACT_ENQUIRY",
      payload: { enquiryId: "x" },
      idempotencyKey: `lease-${randomUUID()}`,
    });
    const first = await claimJob("worker-a");
    expect(first?.id).toBe(job.id);
    const second = await claimJob("worker-b");
    expect(second).toBeNull();
  });

  it("recovers a job whose worker died by releasing the expired lease", async () => {
    const job = await enqueueJob({
      type: "EXTRACT_ENQUIRY",
      payload: { enquiryId: "y" },
      idempotencyKey: `stale-${randomUUID()}`,
    });
    await claimJob("worker-a");
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000), lockedAt: new Date(Date.now() - 120_000) },
    });
    const released = await releaseExpiredJobs();
    expect(released.requeued).toBeGreaterThanOrEqual(1);
    const reloaded = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(reloaded?.status).toBe("QUEUED");
    expect(reloaded?.lockedBy).toBeNull();
  });

  it("allows an owner to retry a dead-lettered job", async () => {
    const job = await enqueueJob({
      type: "EXTRACT_ENQUIRY",
      payload: { enquiryId: "z" },
      idempotencyKey: `dead-${randomUUID()}`,
      maxAttempts: 1,
    });
    await db.backgroundJob.update({
      where: { id: job.id },
      data: { status: "FAILED", attempts: 1, lastError: "boom", deadLetteredAt: new Date() },
    });
    await retryJob(job.id, "owner");
    const reloaded = await db.backgroundJob.findUnique({ where: { id: job.id } });
    expect(reloaded?.status).toBe("QUEUED");
    expect(reloaded?.attempts).toBe(0);
    expect(reloaded?.lastError).toBeNull();
  });
});
