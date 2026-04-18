import { prisma, withPrismaConnectionRetry } from "@/lib/db";
import { getOptionalSessionUser } from "@/lib/current-user";

import { TopBarInner } from "./top-bar-inner";

export async function TopBar() {
  const sessionUser = await getOptionalSessionUser();

  if (!sessionUser) {
    return <TopBarInner unreadNotificationCount={0} user={null} />;
  }

  const [userRecord, unreadNotificationCount] = await Promise.all([
    withPrismaConnectionRetry(() =>
      prisma.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          email: true,
          emailVerified: true,
          image: true,
          name: true,
        },
      })
    ).catch(() => null),
    withPrismaConnectionRetry(() =>
      prisma.notification.count({
        where: { userId: sessionUser.id, readAt: null },
      })
    ).catch(() => 0),
  ]);

  const user = userRecord
    ? {
        email: userRecord.email,
        emailVerified: Boolean(userRecord.emailVerified),
        image: userRecord.image ?? null,
        name: userRecord.name ?? sessionUser.name,
      }
    : {
        email: sessionUser.email,
        emailVerified: false,
        image: null,
        name: sessionUser.name,
      };

  return (
    <TopBarInner
      unreadNotificationCount={unreadNotificationCount ?? 0}
      user={user}
    />
  );
}
