import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(process.cwd(), "src", "app");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Turns app-router files into concrete sample paths. */
function knownRoutes(): string[] {
  const routes = new Set<string>();
  for (const file of walk(APP_ROOT)) {
    if (!/(page|route)\.(tsx?|jsx?)$/.test(file)) continue;
    const relative = path.relative(APP_ROOT, path.dirname(file)).split(path.sep);
    const segments = relative
      .filter((segment) => segment && !/^\(.*\)$/.test(segment))
      .map((segment) => (segment.startsWith("[") ? "sample" : segment));
    routes.add(`/${segments.join("/")}`.replace(/\/$/, "") || "/");
  }
  return [...routes];
}

function sourceFiles(): string[] {
  return walk(path.join(process.cwd(), "src")).filter((file) => /\.(tsx?|jsx?)$/.test(file));
}

describe("route integrity", () => {
  const routes = knownRoutes();

  it("resolves index routes for every section", () => {
    for (const route of ["/", "/enquiries", "/sourcing", "/inventory", "/suppliers", "/approvals", "/activity", "/settings", "/account", "/demo", "/login"]) {
      expect(routes, `missing route ${route}`).toContain(route);
    }
  });

  it("has no internal link that points at a missing route", () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:href|action)="(\/[^"$`]*)"/g)) {
        const raw = match[1];
        const target = raw.split(/[?#]/)[0].replace(/\/$/, "") || "/";
        if (target.startsWith("/api/")) {
          if (!routes.includes(target)) missing.push(`${path.relative(process.cwd(), file)} → ${raw}`);
          continue;
        }
        if (!routes.includes(target)) missing.push(`${path.relative(process.cwd(), file)} → ${raw}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not link to the removed /settings/integrations route", () => {
    const offenders = sourceFiles().filter((file) =>
      fs.readFileSync(file, "utf8").includes("/settings/integrations"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("role-aware navigation", () => {
  it("hides owner-only destinations from staff and keeps them for the owner", async () => {
    const { visibleNavItems } = await import("../src/components/nav");
    const staff = visibleNavItems("STAFF", true).map((item) => item.href);
    const owner = visibleNavItems("OWNER", true).map((item) => item.href);
    expect(staff).not.toContain("/settings");
    expect(staff).not.toContain("/approvals");
    expect(owner).toContain("/settings");
    expect(owner).toContain("/approvals");
    expect(staff).toContain("/enquiries");
    expect(staff).toContain("/account");
  });

  it("only shows the demo walkthrough when demo mode is on", async () => {
    const { visibleNavItems } = await import("../src/components/nav");
    expect(visibleNavItems("OWNER", false).map((item) => item.href)).not.toContain("/demo");
    expect(visibleNavItems("OWNER", true).map((item) => item.href)).toContain("/demo");
  });
});
