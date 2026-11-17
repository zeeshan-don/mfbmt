import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseJson } from "@/lib/json";
import { MAPPABLE_FIELDS, guessMapping } from "@/lib/inventory/import";
import { Button, ButtonLink, Card, CardHeader, Notice, PageHeader, inputClass } from "@/components/ui";
import { previewInventoryImportAction, runInventoryImportAction } from "@/app/actions/inventory";

export const dynamic = "force-dynamic";

export default async function InventoryImportPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;

  const setting = params.token ? await db.appSetting.findUnique({ where: { key: params.token } }) : null;
  const parsed = setting
    ? parseJson<{ headers: string[]; rows: string[][]; sheetName: string; filename: string }>(setting.value, {
        headers: [],
        rows: [],
        sheetName: "",
        filename: "",
      })
    : null;
  const mapping = parsed ? guessMapping(parsed.headers) : {};

  return (
    <div className="space-y-5">
      <PageHeader
        title="Import inventory"
        description="Upload your stock spreadsheet, map the columns once, and confirm the rows. No fixed template is required."
        actions={<ButtonLink href="/inventory" size="sm" variant="ghost">Back to inventory</ButtonLink>}
      />

      {params.error ? <Notice tone="danger" title="Import problem">{params.error}</Notice> : null}

      {!parsed ? (
        <Card>
          <CardHeader title="Upload a spreadsheet" description="Excel (.xlsx) or CSV. The first sheet is used." />
          <form action={previewInventoryImportAction} className="space-y-3 px-4 py-4">
            <label className="block text-xs text-soft">
              File
              <input
                type="file"
                name="file"
                accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                required
                className="mt-1 block w-full cursor-pointer rounded-control border border-line bg-bg px-3 py-2 text-sm text-soft file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-2 file:py-1 file:text-xs file:text-ink"
              />
            </label>
            <p className="text-[11px] text-muted">
              Legacy .xls files are not read directly — save them as .xlsx or .csv first. Formulas are never trusted; only stored values are imported.
            </p>
            <Button variant="primary">Read the file</Button>
          </form>
        </Card>
      ) : (
        <>
          <Notice tone="info" title={`${parsed.filename} — “${parsed.sheetName}”`}>
            {parsed.rows.length} row(s) found. Confirm which column holds each value, then import.
          </Notice>

          <Card>
            <CardHeader title="Match your columns" description="Columns marked * are required." />
            <form action={runInventoryImportAction} className="space-y-4 px-4 py-4">
              <input type="hidden" name="token" value={params.token} />
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {MAPPABLE_FIELDS.map((field) => (
                  <label key={field.key} className="block text-xs text-soft">
                    {field.label}
                    {field.required ? " *" : ""}
                    <select name={`map_${field.key}`} defaultValue={mapping[field.key] ?? ""} className={`${inputClass} mt-1`}>
                      <option value="">— not in file —</option>
                      {parsed.headers.map((header, index) => (
                        <option key={`${header}-${index}`} value={index}>
                          {header || `Column ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                <label className="block text-xs text-soft">
                  Default location code
                  <input name="locationCode" defaultValue="MAIN" className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-xs text-soft">
                  Default location name
                  <input name="locationName" defaultValue="Main warehouse" className={`${inputClass} mt-1`} />
                </label>
              </div>

              <details>
                <summary className="cursor-pointer text-xs font-medium text-accent">Preview the first rows</summary>
                <div className="mt-2 overflow-x-auto rounded-card border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-elevated">
                      <tr>
                        {parsed.headers.map((header, index) => (
                          <th key={`${header}-${index}`} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-soft">
                            {header || `Column ${index + 1}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-t border-line">
                          {parsed.headers.map((_, cellIndex) => (
                            <td key={cellIndex} className="whitespace-nowrap px-2 py-1.5 text-soft">
                              {row[cellIndex] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <div className="flex items-center justify-between">
                <p className="text-[11px] text-muted">
                  Existing product codes are updated; new codes are created. A row with an invalid quantity is skipped and reported.
                </p>
                <Button variant="primary">Import inventory</Button>
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
