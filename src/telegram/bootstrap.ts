import { existsSync } from 'node:fs';

import type { Logger } from '../log/logger.ts';
import { loadAccess, saveAccess } from './access.ts';

/** First run: seed an owner-only `access.json`; later runs log the policy in force. */
export function bootstrapAccess(path: string, log: Logger): void {
  if (!existsSync(path)) {
    saveAccess(path, { policy: 'owner_only', allowedUsers: [], allowedChats: [] });
    log.info(`created ${path} (policy=owner_only, chats=[])`);
    return;
  }
  const access = loadAccess(path, log);
  log.info(`access: policy=${access.policy}, allowed_users=${access.allowedUsers.length}, allowed_chats=${access.allowedChats.length}`);
}
