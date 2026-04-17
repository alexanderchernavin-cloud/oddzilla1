// Decorates Fastify with `app.redis`.

import fp from "fastify-plugin";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp<{ redisUrl: string }>(async (app, opts) => {
  const redis = new Redis(opts.redisUrl, { lazyConnect: false });
  app.decorate("redis", redis);
  app.addHook("onClose", async () => {
    redis.disconnect();
  });
});
