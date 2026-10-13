import { createServer } from 'node:http';

import type { components } from './generated/client.js';

type Order = components['schemas']['Order'];

const orders: Order[] = [{ id: 'ord_1', total: 4200 }];

createServer((_req, res) => {
  console.log('GET /orders');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(orders));
}).listen(3000);
