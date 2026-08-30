// The fuzz / repro CLI (backlog H4).
//
//   pnpm fuzz                      # smoke tier: seeds 0..199
//   pnpm fuzz --from 0 --to 1000   # an explicit range
//   pnpm fuzz --seed 1234          # replay one seed, verbosely
//
// A failing seed is written to fuzz-failures/<seed>.json and re-running
// `--seed <n>` reproduces it exactly: same schedule, same trace hash, same
// violation.
import { mkdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { InvariantViolation, runCampaign } from '../campaign.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const raw = arg(name);
  return raw === undefined ? fallback : Number(raw);
};

const single = arg('seed');
const from = single !== undefined ? Number(single) : num('from', 0);
const to = single !== undefined ? Number(single) + 1 : num('to', 200);
const steps = num('steps', 60);
const clients = num('clients', 3);
const duplicateRate = num('dup', 0.05);

let failures = 0;
const started = from;
console.log(
  `fuzz: seeds [${String(from)}, ${String(to)}) · ${String(clients)} clients · ${String(steps)} steps · dup ${String(duplicateRate)}`,
);

for (let seed = from; seed < to; seed++) {
  try {
    const result = runCampaign({ seed, steps, clients, duplicateRate });
    if (single !== undefined) {
      console.log(
        `seed ${String(seed)} OK — ${String(result.ops)} ops, ${String(result.revocations)} revocations, ` +
          `${String(result.reconnects)} reconnects, head seq ${String(result.serverSeq)}, trace ${result.traceHash.toString(16)}`,
      );
    }
  } catch (cause) {
    failures += 1;
    const detail =
      cause instanceof InvariantViolation
        ? { invariant: cause.invariant, message: cause.message }
        : { invariant: 'crash', message: String(cause) };
    mkdirSync('fuzz-failures', { recursive: true });
    writeFileSync(
      `fuzz-failures/${String(seed)}.json`,
      `${JSON.stringify({ seed, steps, clients, duplicateRate, ...detail }, null, 2)}\n`,
    );
    console.error(`FAIL seed ${String(seed)}: ${detail.message}`);
    if (cause instanceof Error && cause.stack !== undefined && single !== undefined) {
      console.error(cause.stack);
    }
  }
}

const count = to - started;
if (failures === 0) {
  console.log(`all ${String(count)} seeds upheld invariants (a), (b), and (c)`);
  process.exit(0);
}
console.error(`${String(failures)} of ${String(count)} seeds FAILED — artifacts in fuzz-failures/`);
process.exit(1);
