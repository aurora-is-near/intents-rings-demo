import { writeFileSync, mkdirSync } from 'node:fs';

export type Stage =
  | 't_quote' | 't_registry' | 't_settle' | 't_sign' | 't_deposit' | 't_index';

export interface Sample { stage: Stage; ms: number; ok: boolean; note?: string; at: string }

export class Timer {
  private samples: Sample[] = [];
  private runId = new Date().toISOString().replace(/[:.]/g, '-');

  async measure<T>(stage: Stage, fn: () => Promise<T>, note?: string): Promise<T> {
    const t0 = performance.now();
    try {
      const out = await fn();
      this.record(stage, performance.now() - t0, true, note);
      return out;
    } catch (e: any) {
      this.record(stage, performance.now() - t0, false, `${note ?? ''} ERROR: ${e.message}`.trim());
      throw e;
    }
  }

  record(stage: Stage, ms: number, ok = true, note?: string) {
    const s: Sample = { stage, ms: Math.round(ms), ok, note, at: new Date().toISOString() };
    this.samples.push(s);
    console.log(`  ${ok ? '✓' : '✗'} ${stage.padEnd(11)} ${String(s.ms).padStart(8)} ms  ${note ?? ''}`);
  }

  /** Perceived end-to-end latency: what the user actually waits through. */
  get perceivedMs() {
    const counted: Stage[] = ['t_quote', 't_settle', 't_sign', 't_deposit', 't_index'];
    return this.samples.filter(s => counted.includes(s.stage)).reduce((a, s) => a + s.ms, 0);
  }

  report() {
    console.log(`\n  perceived end-to-end: ${(this.perceivedMs / 1000).toFixed(1)}s`);
    mkdirSync('out', { recursive: true });
    const base = `out/run-${this.runId}`;
    writeFileSync(`${base}.json`, JSON.stringify({ perceivedMs: this.perceivedMs, samples: this.samples }, null, 2));
    const csv = ['stage,ms,ok,at,note',
      ...this.samples.map(s => `${s.stage},${s.ms},${s.ok},${s.at},"${(s.note ?? '').replace(/"/g, "'")}"`)].join('\n');
    writeFileSync(`${base}.csv`, csv);
    console.log(`  wrote ${base}.json / .csv`);
  }
}
