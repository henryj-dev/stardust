/**
 * What things cost each month, from whoever bills for them. A provider that
 * knows (a compute account: its instances' plans) offers this port next to
 * its main one; the `costs` feature adds them up for the home page.
 */
export interface CostLine {
  /** What is billed, e.g. an instance's hostname. */
  name: string;
  /** e.g. its plan. */
  detail: string;
  monthly: number;
}

export interface CostReport {
  currency: string;
  lines: CostLine[];
}

export interface CostSource {
  monthly(): Promise<CostReport>;
}
