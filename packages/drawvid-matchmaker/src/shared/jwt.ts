import { sign } from 'jsonwebtoken';

export function issueWorldToken(
  userId: string,
  gameKey: string,
  worldId: string,
  ttlSeconds: number,
  secret: string
): string {
  const now = Math.floor(Date.now() / 1000);

  return sign(
    {
      sub: userId,
      gameKey,
      worldId,
      iat: now,
      exp: now + ttlSeconds,
    },
    secret,
    { algorithm: 'HS256' }
  );
}
