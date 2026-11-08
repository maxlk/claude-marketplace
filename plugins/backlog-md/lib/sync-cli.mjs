// Detached worker for hook-triggered sync, so hooks return within their budget.
import { resolveContext, isConfigured } from './context.mjs';
import { onEnd, onStart, onStop } from './sync.mjs';

const [, , cwd, action, session] = process.argv;
try {
  const ctx = resolveContext(cwd);
  if (isConfigured(ctx)) {
    if (action === 'start') onStart(ctx);
    else if (action === 'stop') onStop(ctx);
    else if (action === 'end') onEnd(ctx, session);
  }
} catch {
  // Detached and best effort; `backlog-md sync --status` exposes the result.
}
