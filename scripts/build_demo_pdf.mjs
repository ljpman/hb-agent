import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createMockPdf } from '../server/pdf.mjs';

const target = path.resolve("output/pdf/hb-agent-demo-plan.pdf");
await mkdir(path.dirname(target), { recursive: true });

const buffer = await createMockPdf({
  id: 'proposal-demo-001', version: 1, createdAt: '2026-09-22T03:30:00.000Z',
  params: {
    gender: '男',
    age: 35,
    smoker: false,
    currency: 'USD',
    annualPremium: '10000.00',
    paymentTerm: '5',
  },
});

await writeFile(target, buffer);
console.log(target);
