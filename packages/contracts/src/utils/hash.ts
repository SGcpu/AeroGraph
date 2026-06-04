export function getDeterministicStateHash(state: Record<string, any>): string {
  // Simple deterministic serialization: sort keys
  const sortedState = sortKeys(state);
  const serialized = JSON.stringify(sortedState) || "";
  
  let h = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    h ^= serialized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function sortKeys(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }

  const sortedObj: Record<string, any> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sortedObj[key] = sortKeys(obj[key]);
  }

  return sortedObj;
}

export function computeStateDiff(
  prevState: Record<string, any>,
  currentState: Record<string, any>
): { stateDiff: Record<string, any>, removedKeys: string[] } {
  const diff: Record<string, any> = {};
  const removedKeys: string[] = [];

  // Find added and changed keys
  for (const [key, value] of Object.entries(currentState)) {
    const prevValue = prevState[key];
    if (JSON.stringify(sortKeys(value)) !== JSON.stringify(sortKeys(prevValue))) {
      diff[key] = value;
    }
  }

  // Find removed keys
  for (const key of Object.keys(prevState)) {
    if (!(key in currentState)) {
      removedKeys.push(key);
    }
  }

  return { stateDiff: diff, removedKeys };
}
