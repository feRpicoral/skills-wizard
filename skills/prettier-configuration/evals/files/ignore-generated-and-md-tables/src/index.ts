import type { Order } from './generated/graphql.js';

export function describeOrder(order: Order): string {
  return `${order.id} is ${order.status}`;
}
