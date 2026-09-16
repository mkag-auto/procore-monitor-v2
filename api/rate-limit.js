// api/rate-limit.js — last known Procore API rate limit for this user
const { requireSession, makeCtx, getRateLimitCached } = require('./_procore');

module.exports = async (req, res) => {
  const session = await requireSession(req, res, { needCompany: false });
  if (!session) return;
  const rl = await getRateLimitCached(makeCtx(session).userKey);
  res.json({
    limit: rl.limit,
    remaining: rl.remaining,
    reset: rl.reset,
    resetAt: rl.reset ? new Date(rl.reset * 1000).toISOString() : null,
    updatedAt: rl.updatedAt ? new Date(rl.updatedAt).toISOString() : null,
    percentUsed: rl.limit && rl.remaining != null
      ? Math.round(((rl.limit - rl.remaining) / rl.limit) * 100) : null,
  });
};
