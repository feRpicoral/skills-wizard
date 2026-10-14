export interface Invoice {
  id: string;
  totalCents: number;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function parseLegacy(row: string, _strict: boolean) {
  const [id, total] = row.split(",");
  return { id, totalCents: Number(total) };
}
