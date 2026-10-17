import { parentPort, workerData } from 'node:worker_threads';

import { openReadOnly } from './database.ts';
import { selectRows } from './query.ts';

// The thread `queryReadOnly` starts: one query on its own read-only connection.
const { path, sql } = workerData as { path: string; sql: string };
const db = openReadOnly(path);
parentPort?.postMessage(selectRows(db, sql));
db.close();
