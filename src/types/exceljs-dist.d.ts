declare module "exceljs/dist/exceljs.min.js" {
  import type { Workbook } from "exceljs";
  const ExcelJS: { Workbook: new () => Workbook };
  export default ExcelJS;
}
