// Test job type: this thread's V8 heap limit, MB.

import v8 from 'node:v8';

export const type = 'heap-limit';

export function run() {
  return Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
}
