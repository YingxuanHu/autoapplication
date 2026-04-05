import { prisma } from "@/lib/db";

type SyncableUser = {
  id: string;
  email: string;
  name: string;
};

export async function syncProfileForAuthUser(user: SyncableUser) {
  const existingProfile = await prisma.userProfile.findFirst({
    where: {
      OR: [
        { authUserId: user.id },
        { email: user.email },
      ],
    },
    select: {
      id: true,
    },
  });

  if (existingProfile) {
    return prisma.userProfile.update({
      where: { id: existingProfile.id },
      data: {
        authUserId: user.id,
        email: user.email,
        name: user.name,
      },
    });
  }

  return prisma.userProfile.create({
    data: {
      authUserId: user.id,
      email: user.email,
      name: user.name,
    },
  });
}
