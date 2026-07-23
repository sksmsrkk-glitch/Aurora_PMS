/** Stable client merge for keyset pages returned by one search domain. */
export type SearchPageItem = { id: string; kind: string };
export type SearchPageGroup<T extends SearchPageItem> = {
  id: string;
  label: string;
  items: T[];
  nextCursor?: string;
};

export function mergeSearchPage<T extends SearchPageItem>(
  current: SearchPageGroup<T>[],
  incoming: SearchPageGroup<T>,
) {
  return current.map((group) => {
    if (group.id !== incoming.id) return group;
    const seen = new Set(group.items.map((item) => `${item.kind}:${item.id}`));
    return {
      ...group,
      items: [
        ...group.items,
        ...incoming.items.filter(
          (item) => !seen.has(`${item.kind}:${item.id}`),
        ),
      ],
      nextCursor: incoming.nextCursor,
    };
  });
}
