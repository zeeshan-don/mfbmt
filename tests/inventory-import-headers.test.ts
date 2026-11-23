import { describe, expect, it } from "vitest";
import { guessMapping, readTabular } from "../src/lib/inventory/import";

describe("tabular header detection", () => {
  it("uses the first row as headers for a plain table", async () => {
    const tabular = await readTabular(Buffer.from("SKU,Item,Stock\nA-1,Bolt,10\n"));
    expect(tabular.headers).toEqual(["SKU", "Item", "Stock"]);
    expect(tabular.rows).toEqual([["A-1", "Bolt", "10"]]);
  });

  it("skips title rows above the header row", async () => {
    const tabular = await readTabular(
      Buffer.from("MY COMPANY INVENTORY\nReplace this with real counts\nSKU,Item,Stock\nA-1,Bolt,10\n"),
    );
    expect(tabular.headers).toEqual(["SKU", "Item", "Stock"]);
    expect(tabular.rows).toEqual([["A-1", "Bolt", "10"]]);
    expect(guessMapping(tabular.headers)).toMatchObject({ sku: 0, name: 1, quantity: 2 });
  });
});
