export type QueueIdentity = { queueId: string };

export function removeQueueItem<T extends QueueIdentity>(items: T[], queueId: string) {
  return items.filter((item) => item.queueId !== queueId);
}

export function restoreQueueItem<T extends QueueIdentity>(items: T[], item: T, order: Map<string, number>) {
  if (items.some((current) => current.queueId === item.queueId)) return items;
  return [...items, item].sort((a, b) => (order.get(a.queueId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.queueId) ?? Number.MAX_SAFE_INTEGER));
}
