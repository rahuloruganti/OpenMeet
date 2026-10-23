/** The tab a key moves to in a tablist of `count` tabs, or null for any other key. */
export function tabTarget(
  key: string,
  index: number,
  count: number,
  vertical = false,
): number | null {
  const [next, previous] = vertical
    ? ["ArrowDown", "ArrowUp"]
    : ["ArrowRight", "ArrowLeft"];
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === next) return (index + 1) % count;
  if (key === previous) return (index + count - 1) % count;
  return null;
}
