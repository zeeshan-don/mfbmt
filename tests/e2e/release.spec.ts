import { test, expect, type Page } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../src/lib/db";

const SHOTS = path.join(process.cwd(), "tmp-verify", "screenshots");
const FIXTURE_PATH = path.join(process.cwd(), "tmp-verify", "e2e-fixture.json");
const OWNER = { email: "owner@mfbmt.local", password: "ChangeMe123!" };
const STAFF = { email: "staff@mfbmt.local", password: "ChangeMe123!" };

type Fixture = {
  enquiryId: string;
  itemId: string;
  approvalId: string;
  ref: string;
  authEnquiryId: string;
  authItemId: string;
  authApprovalId: string;
  demoNutItemId: string | null;
};

let fixture: Fixture;

test.beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execSync("npx tsx tests/e2e/seed-fixture.ts", { stdio: "inherit", shell: true } as any);
  fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.fill("#email", account.email);
  await page.fill("#password", account.password);
  await Promise.all([page.waitForURL("/"), page.getByRole("button", { name: "Sign in" }).click()]);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function logout(page: Page) {
  // Server-action forms are enhanced after hydration; wait for the action
  // attribute so the click submits the real action rather than doing nothing.
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Sign out" }) }).first();
  await expect(form).toHaveAttribute("action", /.+/);
  await Promise.all([
    page.waitForURL(/\/login/, { timeout: 30_000 }),
    form.evaluate((element) => (element as HTMLFormElement).requestSubmit()),
  ]);
}

function parsePdfFile(file: string) {
  const output = execFileSync(process.execPath, [path.join(process.cwd(), "tests", "e2e", "parse-pdf-cli.cjs"), file], {
    encoding: "utf8",
  });
  return JSON.parse(output) as { pages: number; text: string };
}

test("owner login, dashboard, navigation and logout", async ({ page }) => {
  await login(page, OWNER);
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Good day, MFBMT")).toBeVisible();
  await expect(page.locator(":text-matches(\"Worker active|Worker status unknown\"):visible").first()).toBeVisible();
  await shot(page, "desktop-dashboard");

  for (const [label, heading] of [
    ["Enquiries", "Enquiries"],
    ["Sourcing", "Sourcing"],
    ["Inventory", "Inventory"],
    ["Suppliers", "Suppliers"],
    ["Approvals", "Approvals"],
    ["Activity", "Activity"],
    ["Settings", "Settings"],
  ] as const) {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
  }

  await logout(page);
});

test("fastener demo walkthrough shows stock, missing details and excluded offers", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/demo");
  await expect(page.getByRole("heading", { name: "Fastener owner walkthrough" })).toBeVisible();
  await expect(page.getByText("SAMPLE DATA — NOT LIVE MARKET PRICES")).toBeVisible();
  await shot(page, "desktop-demo-walkthrough");

  await page.getByRole("link", { name: "Enquiry with 3 lines" }).click();
  await expect(page.getByRole("heading", { name: "Al Reem Mechanical (sample)" })).toBeVisible();

  await expect(page.getByText(/Covered by your stock/)).toBeVisible();
  await expect(page.getByText("Partly in stock")).toBeVisible();
  await expect(page.getByText("4 supplier options found", { exact: false })).toBeVisible();
  await expect(page.getByText("Missing details").first()).toBeVisible();
  await expect(page.getByText("Add the missing details before a supplier search", { exact: false })).toBeVisible();
  await expect(page.getByText("1.75 mm long")).toHaveCount(0);
  await shot(page, "desktop-enquiry-fastener");

  await page.getByRole("link", { name: "Compare suppliers" }).click();
  await expect(page.getByRole("heading", { name: "Supplier comparison" })).toBeVisible();
  await expect(page.getByText("Does not match").first()).toBeVisible();
  await expect(page.getByText("This offer does not match the requested specification.").first()).toBeVisible();
  await expect(page.getByText("Incomplete").first()).toBeVisible();
  await expect(page.getByText("AED 5,500.00").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this supplier" })).toBeVisible();
  await shot(page, "desktop-supplier-comparison");
});

test("owner downloads a customer PDF with no internal cost leakage", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/demo");
  await page.getByRole("link", { name: "Customer quotation" }).click();
  await expect(page.getByText("Total", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Internal only")).toBeVisible();
  await shot(page, "desktop-quotation");

  const quotation = await db.customerQuotation.findFirst({
    where: { enquiry: { publicRef: "ENQ-DEMO-FASTENER-02" } },
    select: { id: true },
  });
  expect(quotation).not.toBeNull();
  const response = await page.request.get(`/api/quotations/${quotation!.id}/pdf`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  const buffer = await response.body();
  fs.writeFileSync(path.join(SHOTS, "demo-quotation.pdf"), buffer);
  const parsed = parsePdfFile(path.join(SHOTS, "demo-quotation.pdf"));
  expect(parsed.pages).toBe(1);
  expect(parsed.text).toContain("AED 341.25");
  expect(parsed.text).toContain("VAT");
  expect(parsed.text).toMatch(/Page 1 of 1/);
  expect(parsed.text.toLowerCase()).not.toContain("supplier cost");
  expect(parsed.text.toLowerCase()).not.toContain("margin");
  expect(parsed.text.toLowerCase()).not.toContain("internal");
});

test("staff navigation and server-side guards deny owner-only pages and costs", async ({ page }) => {
  await login(page, STAFF);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "Enquiries", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Approvals", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Demo walkthrough", exact: true })).toHaveCount(0);
  await shot(page, "desktop-staff-dashboard");

  for (const pathName of ["/settings", "/approvals", "/approvals/" + fixture.authApprovalId, "/demo", "/inventory/import"]) {
    await page.goto(pathName);
    await expect(page).toHaveURL(/denied=1/);
  }

  const quotation = await db.customerQuotation.findFirst({
    where: { enquiry: { publicRef: "ENQ-DEMO-FASTENER-02" } },
    select: { id: true },
  });
  await page.goto(`/quotations/${quotation!.id}`);
  await expect(page).toHaveURL(/denied=1/);

  await page.goto(`/sourcing/${fixture.demoNutItemId}`);
  await expect(page.getByRole("heading", { name: "Supplier comparison" })).toBeVisible();
  await expect(page.getByText("Supplier costs are visible to the owner only.")).toBeVisible();
  await expect(page.getByText("Unit price", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Est. total", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve this supplier" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search again" })).toHaveCount(0);
  await expect(page.getByText("Only the owner can request supplier quotations or record supplier prices.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("AED ");
  await shot(page, "desktop-staff-sourcing-redacted");
});

test("staff cannot approve through a direct server-action request", async ({ page, browser }) => {
  await login(page, OWNER);
  await page.goto(`/approvals/${fixture.authApprovalId}`);

  // Capture the real action request that the owner page would send, then abort
  // it so the fixture stays pending. Replaying it with a staff session proves
  // the server action itself rejects the caller, not just the page navigation.
  type Captured = { url: string; headers: Record<string, string>; body: Buffer | null };
  let captured: Captured | null = null;
  await page.route(`**/approvals/${fixture.authApprovalId}`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    captured = {
      url: request.url(),
      headers: request.headers(),
      body: request.postDataBuffer(),
    };
    await route.abort();
  });

  await page.getByRole("button", { name: /Approve selected supplier/i }).click();
  await expect.poll(() => Boolean(captured), { timeout: 10_000 }).toBe(true);
  const actionRequest = captured!;
  expect(actionRequest.headers["next-action"]).toBeTruthy();

  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await login(staffPage, STAFF);
  // Never replay the owner's cookie: the staff session must authenticate the
  // action on its own. Keep the action id and body from the captured request.
  const replayHeaders = { ...actionRequest.headers };
  delete replayHeaders.cookie;
  delete replayHeaders.host;
  delete replayHeaders.origin;
  delete replayHeaders.referer;
  delete replayHeaders["content-length"];
  const response = await staffPage.request.post(actionRequest.url, {
    headers: replayHeaders,
    data: actionRequest.body ?? undefined,
    maxRedirects: 0,
  });
  // The action ran: authorizeOwner() redirects a staff session to /login. A
  // plain page render would redirect to /?denied=1 instead.
  expect([303, 307]).toContain(response.status());
  expect(response.headers()["x-action-redirect"] ?? response.headers()["location"] ?? "").toContain("/login");
  const approval = await db.approval.findUnique({ where: { id: fixture.authApprovalId } });
  expect(approval?.status).toBe("PENDING");
  const item = await db.enquiryItem.findUnique({ where: { id: fixture.authItemId } });
  expect(item?.approvedOfferId).toBeNull();
  await staffContext.close();
});

test("complete approval, quotation approval and PDF flow on an isolated copy", async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/sourcing/${fixture.itemId}`);
  await page.waitForTimeout(1000);
  await Promise.all([
    page.waitForURL(/approved=1/),
    page.getByRole("button", { name: "Approve this supplier" }).click(),
  ]);
  await page.goto(`/enquiries/${fixture.enquiryId}`);
  await expect(page.getByText("Supplier approved").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare customer quotation" })).toBeVisible();
  await shot(page, "desktop-approved-sourcing");

  await Promise.all([
    page.waitForURL(/\/quotations\//),
    page.getByRole("button", { name: "Prepare customer quotation" }).click(),
  ]);
  const quotationId = page.url().split("/quotations/")[1].split("?")[0];
  await expect(page.getByText("This quotation is not approved yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create PDF" })).toHaveCount(0);
  await shot(page, "desktop-quotation-awaiting-approval");

  const approval = await db.approval.findFirst({
    where: { entityId: quotationId, type: "CUSTOMER_QUOTATION", status: "PENDING" },
  });
  expect(approval).not.toBeNull();
  await page.goto(`/approvals/${approval!.id}`);
  await page.waitForTimeout(800);
  await Promise.all([
    page.waitForURL(/\/quotations\//),
    page.getByRole("button", { name: "Approve quotation" }).click(),
  ]);
  await Promise.all([
    page.waitForURL(/pdf=1/),
    page.getByRole("button", { name: "Create PDF" }).click(),
  ]);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const download = await downloadPromise;
  const pdfPath = path.join(SHOTS, "e2e-quotation.pdf");
  await download.saveAs(pdfPath);
  const parsed = parsePdfFile(pdfPath);
  expect(parsed.pages).toBe(1);
  expect(parsed.text).toContain("E2E Verification Customer");
  expect(parsed.text.toLowerCase()).not.toContain("supplier cost");
  expect(parsed.text.toLowerCase()).not.toContain("margin");
  expect(parsed.text.toLowerCase()).not.toContain("internal");
});

test("mobile navigation, enquiry detail and sign-out", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, OWNER);
  await expect(page.getByText("Good day, MFBMT")).toBeVisible();
  await shot(page, "mobile-dashboard");

  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "Enquiries", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Approvals", exact: true })).toBeVisible();
  await shot(page, "mobile-navigation");

  await nav.getByRole("link", { name: "Enquiries", exact: true }).click();
  await page.getByRole("link", { name: "Al Reem Mechanical (sample)" }).click();
  await expect(page.getByText("Missing details").first()).toBeVisible();
  await shot(page, "mobile-enquiry-fastener");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await logout(page);
  await context.close();
});
