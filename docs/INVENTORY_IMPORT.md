# Inventory import

Stock is the first place the system looks, so the import has to be predictable. There are two ways to load stock: a spreadsheet import from the UI, and the demo seed. Everything is stored per product per location.

## What a row means

Each row becomes (or updates) one product and sets its quantity at one location.

| Column | Required | Notes |
|---|---|---|
| Product name | Yes | Used to match an existing product |
| Quantity on hand | Yes | Whole numbers; decimals are rejected rather than rounded |
| SKU / product code | No | If present, an existing SKU wins over the name |
| Reserved quantity | No | Must not exceed quantity on hand |
| Location | No | Defaults to the location you choose on the import screen |
| Category | No | Inferred from the description when blank |
| Unit | No | Defaults to `pcs` |
| Brand, size, material, grade, pressure rating, schedule, standard | No | Normalised and used for specification matching |

### Matching rules

1. **SKU** — if the row has a SKU and it exists, that product is updated.
2. **Name + size + material + grade** (normalised) — if exactly one product matches, it is updated.
3. Otherwise a new product is created. A row is never merged into a product when the match is ambiguous; it is reported instead.

Quantities are **set**, not added. Importing the same file twice is therefore safe. The movement record shows `IMPORT` with the delta and the importing user.

## Supported files

- `.xlsx` (first worksheet)
- `.csv` (UTF-8, comma separated; a UTF-8 BOM is handled)

Old `.xls` files must be re-saved as `.xlsx`. Maximum upload size is `MAX_UPLOAD_MB` (15 MB by default).

Headers are guessed from common names (`Qty`, `On Hand`, `Stock`, `Description`, `Item Code`, `Warehouse`, …). You can override every column on the mapping screen before anything is written.

A title, disclaimer or blank row above the table is skipped: the first row of the first ten that looks like column names is used as the header. A grouping column such as `Product family` is treated as the category, not as the product name, so the `Item`/`Description` column is guessed for the name.

## Steps

1. **Inventory → Import**
2. Choose the file. The app reads the header row and shows a preview of the first rows.
3. Check the column mapping. Product name and quantity are mandatory; warning text appears if they are unmapped.
4. Choose the default location (code and name). A new location is created if it does not exist.
5. Press **Import**. The page reports created / updated / skipped counts and lists row-level errors.

Nothing is written until you press Import, and the whole import runs in one transaction — a crash leaves the previous stock untouched.

## Normalisation

Size (`1"`, `1 inch`, `DN25`, `25mm`), material (`SS316`, `Stainless Steel 316`, `A4`), grade (`8.8`, `A2-70`), pressure (`PN16`, `150#`) and unit (`pcs`, `pieces`, `nos`, `box`) are normalised for comparison. The original text is kept on the product for display.

## Staleness

`InventoryStock.lastUpdatedAt` is set on every import and manual adjustment. Stock not confirmed for **30 days** is flagged as stale in the product list and treated cautiously during a stock check. A stale match can still save sourcing time, but the UI says it needs confirmation and the quotation shows the stock note.

## Manual changes

- **Adjust stock** on a product writes a movement with a reason and the user.
- **Reserve / release** is done through the movement record so the available figure (`on hand − reserved`) is always explainable.
- Deactivating a product keeps its history; it will not match new enquiries.

## Demo data

`npm run seed` creates three sample products and a warehouse location, clearly marked as demo. They exist so the workflow can be exercised end to end. Replace them with a real import before going live and set `SEED_DEMO_DATA=false` (or simply do not run the seed on the production database).

## Common problems

| Symptom | Cause / fix |
|---|---|
| "Upload an Excel (.xlsx) or CSV file" | File is `.xls`, `.xlsb` or a renamed document. Re-save as `.xlsx`. |
| Header row not detected / every column unmapped | The header is further than ten rows down, or the column names share no common words. Fix the mapping by hand on the mapping screen. |
| Row skipped with "quantity is not a whole number" | Fractional stock is not supported; split the row by unit or correct the value. |
| Row skipped with "reserved exceeds on hand" | Fix the source data; the app will not create negative availability. |
| New product created instead of updating | Size/material/grade differ from the existing product once normalised, or the name matched more than one product. Add a SKU to make matching exact. |
| Numbers look like text | Excel cells formatted as text are read as-is. Clear formatting or fix the cell values. |
