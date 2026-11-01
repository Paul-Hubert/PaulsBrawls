// Test job type: always throws.

export const type = 'throws';

export function run(input) {
  throw new TypeError(`boom ${input}`);
}
