import { describe, expect, it } from "vitest";
import { createEnquiryDealKeyResolver, selectPrimaryOwnerActions, type OwnerWorkItem } from "../src/lib/workflow/ownerWorkQueue";

function item(overrides: Partial<OwnerWorkItem> & Pick<OwnerWorkItem, "id" | "dealKey" | "priority" | "createdAt">): OwnerWorkItem {
  return {
    kind: "TEST",
    title: overrides.id,
    detail: "Test work item",
    action: "Open",
    href: "/",
    ...overrides,
  };
}

describe("owner next-action queue", () => {
  it("shows only one primary action per deal", () => {
    const actions = selectPrimaryOwnerActions([
      item({ id: "review", dealKey: "enquiry:1", priority: "high", createdAt: new Date("2026-11-27T10:00:00Z") }),
      item({ id: "acceptance", dealKey: "enquiry:1", priority: "urgent", createdAt: new Date("2026-11-27T11:00:00Z") }),
      item({ id: "other", dealKey: "enquiry:2", priority: "normal", createdAt: new Date("2026-11-27T09:00:00Z") }),
    ]);

    expect(actions.map((action) => action.id)).toEqual(["acceptance", "other"]);
  });

  it("uses the oldest item when two actions for one deal have equal priority", () => {
    const oldest = new Date("2026-11-25T10:00:00Z");
    const newest = new Date("2026-11-26T10:00:00Z");
    const actions = selectPrimaryOwnerActions([
      item({ id: "new", dealKey: "order:1", priority: "high", createdAt: newest }),
      item({ id: "old", dealKey: "order:1", priority: "high", createdAt: oldest }),
    ]);

    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("old");
  });

  it("sorts urgent actions ahead of high and normal work", () => {
    const actions = selectPrimaryOwnerActions([
      item({ id: "normal", dealKey: "a", priority: "normal", createdAt: new Date("2026-11-20T10:00:00Z") }),
      item({ id: "high", dealKey: "b", priority: "high", createdAt: new Date("2026-11-26T10:00:00Z") }),
      item({ id: "urgent", dealKey: "c", priority: "urgent", createdAt: new Date("2026-11-27T10:00:00Z") }),
    ]);

    expect(actions.map((action) => action.id)).toEqual(["urgent", "high", "normal"]);
  });

  it("respects the requested queue limit", () => {
    const actions = selectPrimaryOwnerActions(
      Array.from({ length: 5 }, (_, index) =>
        item({
          id: `item-${index}`,
          dealKey: `deal-${index}`,
          priority: "normal",
          createdAt: new Date(Date.UTC(2026, 10, 20 + index)),
        }),
      ),
      3,
    );

    expect(actions).toHaveLength(3);
  });

  it("groups enquiry work under its single active sales order", () => {
    const resolve = createEnquiryDealKeyResolver([
      { id: "order-1", enquiryId: "enquiry-1" },
    ]);

    expect(resolve("enquiry-1")).toBe("order:order-1");
    expect(resolve("enquiry-2")).toBe("enquiry:enquiry-2");
  });

  it("does not guess which order owns enquiry work when multiple orders exist", () => {
    const resolve = createEnquiryDealKeyResolver([
      { id: "order-1", enquiryId: "enquiry-1" },
      { id: "order-2", enquiryId: "enquiry-1" },
    ]);

    expect(resolve("enquiry-1")).toBe("enquiry:enquiry-1");
  });

  it("returns an empty queue when there is no outstanding work", () => {
    expect(selectPrimaryOwnerActions([])).toEqual([]);
  });

  it("does not return more than one action when limits are applied after deduplication", () => {
    const actions = selectPrimaryOwnerActions([
      item({ id: "a1", dealKey: "same", priority: "high", createdAt: new Date("2026-11-25T10:00:00Z") }),
      item({ id: "a2", dealKey: "same", priority: "urgent", createdAt: new Date("2026-11-26T10:00:00Z") }),
      item({ id: "b1", dealKey: "different", priority: "normal", createdAt: new Date("2026-11-27T10:00:00Z") }),
    ], 1);

    expect(actions).toHaveLength(1);
    expect(actions[0].dealKey).toBe("same");
  });
});
