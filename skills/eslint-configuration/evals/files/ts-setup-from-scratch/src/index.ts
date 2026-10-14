import { readFile } from "node:fs/promises";
import { z } from "zod";
import { formatCents, Invoice } from "./invoice.js";
import { join } from "node:path";

const InvoiceSchema = z.object({ id: z.string(), totalCents: z.number() });

export async function main(path: string) {
  const raw = await readFile(path, "utf8");
  const invoice: Invoice = InvoiceSchema.parse(JSON.parse(raw));
  console.log(`${invoice.id}: ${formatCents(invoice.totalCents)}`);
}
