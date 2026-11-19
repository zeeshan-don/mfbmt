type OrgLike = {
  name?: string | null;
  quotationValidityDays?: number | null;
  defaultCurrency?: string | null;
  taxEnabled?: boolean | null;
  taxLabel?: string | null;
} | null;

export function buildQuoteTerms(org: OrgLike): string {
  const validity = org?.quotationValidityDays ?? 14;
  const taxLine = org?.taxEnabled
    ? `${org?.taxLabel ?? "VAT"} is shown separately where applicable.`
    : "Prices exclude taxes unless stated. VAT will be applied as required by UAE law.";
  return [
    `Quotation valid for ${validity} days from the date of issue.`,
    "Prices are based on supplier availability at the time of quotation and may change if stock or supplier pricing changes.",
    "Delivery is subject to stock confirmation and transport availability.",
    `Payment terms as agreed with ${org?.name ?? "the company"} accounts.`,
    taxLine,
    "This quotation is not an invoice and does not reserve stock.",
  ].join("\n");
}
