import { AsyncLocalStorage } from "node:async_hooks";

export interface AeroGraphContext {
  spanId: string | null;
  branchId: string;
}

const storage = new AsyncLocalStorage<AeroGraphContext>();
const branchSeqCounters = new Map<string, number>();

export function getCurrentSpanId(): string | null {
  return storage.getStore()?.spanId ?? null;
}

export function getCurrentBranchId(): string {
  return storage.getStore()?.branchId ?? "root";
}

export function nextLocalSeq(branchId?: string): number {
  const bid = branchId || getCurrentBranchId();
  const seq = branchSeqCounters.get(bid) ?? 0;
  branchSeqCounters.set(bid, seq + 1);
  return seq;
}

export function resetBranchCounters(): void {
  branchSeqCounters.clear();
}

export function childBranchId(name: string, index?: number, parentBranch?: string): string {
  const parent = parentBranch || getCurrentBranchId();
  const suffix = index !== undefined ? `[${index}]` : "";
  return `${parent}.${name}${suffix}`;
}

export function runWithSpanContext<T>(
  spanId: string | null,
  branchId: string | undefined,
  fn: () => T
): T {
  const activeBranch = branchId ?? getCurrentBranchId();
  return storage.run({ spanId, branchId: activeBranch }, fn);
}
