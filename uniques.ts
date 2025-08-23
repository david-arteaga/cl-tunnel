export default function uniques<Item>(items: Item[]): Item[] {
  return Array.from(new Set(items));
}

export function uniquesBy<Item, Key>(
  items: Item[],
  getKey: (item: Item) => Key,
  getShouldDedupe: (item: Item) => boolean = () => true,
  existingKeys: Set<Key> = new Set()
): Item[] {
  const keys = existingKeys;
  return items.filter((item) => {
    const shouldDedupe = getShouldDedupe(item);
    const key = getKey(item);

    const alreadyHas = keys.has(key);
    keys.add(key);

    if (!shouldDedupe) return true;

    if (alreadyHas) return false;
    return true;
  });
}
