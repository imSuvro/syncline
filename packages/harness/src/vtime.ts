// Virtual time: a (dueAt, insertionSeq) binary-heap scheduler. Nothing in
// any core reads a clock; `now` rides every input from here (ADR-001).

interface Task {
  at: number;
  seq: number;
  fn: () => void;
}

export class VirtualClock {
  private heap: Task[] = [];
  private seq = 0;
  private nowMs = 0;

  get now(): number {
    return this.nowMs;
  }

  schedule(delayMs: number, fn: () => void): void {
    const task: Task = { at: this.nowMs + Math.max(0, Math.floor(delayMs)), seq: this.seq++, fn };
    this.heap.push(task);
    this.up(this.heap.length - 1);
  }

  /** Run until no tasks remain (or the safety cap trips). */
  runUntilQuiescent(maxEvents = 1_000_000): number {
    let events = 0;
    while (this.heap.length > 0) {
      if (++events > maxEvents) throw new Error('virtual clock: event cap exceeded');
      const task = this.pop();
      this.nowMs = task.at;
      task.fn();
    }
    return events;
  }

  private less(i: number, j: number): boolean {
    const a = this.heap[i] as Task;
    const b = this.heap[j] as Task;
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): Task {
    const top = this.heap[0] as Task;
    const last = this.heap.pop() as Task;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.heap.length && this.less(l, m)) m = l;
        if (r < this.heap.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    const t = this.heap[i] as Task;
    this.heap[i] = this.heap[j] as Task;
    this.heap[j] = t;
  }
}
