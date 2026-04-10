import type { DeadlineReminderType, TrackedApplicationStatus } from "@/generated/prisma/client";

import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/db";
import { TRACKED_ACTIVE_STATUSES } from "@/lib/tracker-constants";

type ReminderRunResult = {
  scannedApplications: number;
  remindersCreated: number;
  remindersSkipped: number;
};

type TrackedApplicationWithUser = {
  id: string;
  company: string;
  roleTitle: string;
  deadline: Date | null;
  userId: string;
  user: {
    email: string;
    emailNotificationsEnabled: boolean;
    name: string;
  };
};

function startOfUtcDay(date: Date) {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function daysUntil(deadline: Date, today: Date) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor(
    (startOfUtcDay(deadline).getTime() - startOfUtcDay(today).getTime()) / msPerDay
  );
}

function mapReminderType(dayDiff: number): DeadlineReminderType | null {
  if (dayDiff === 7) return "DEADLINE_D7";
  if (dayDiff === 3) return "DEADLINE_D3";
  if (dayDiff === 1) return "DEADLINE_D1";
  if (dayDiff === 0) return "DEADLINE_TODAY";
  if (dayDiff === -1) return "DEADLINE_OVERDUE_D1";
  return null;
}

function buildReminderCopy(input: {
  reminderType: DeadlineReminderType;
  company: string;
  roleTitle: string;
  deadline: Date;
}) {
  const deadlineText = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
  }).format(input.deadline);
  const base = `${input.company} — ${input.roleTitle}`;

  if (input.reminderType === "DEADLINE_D7") {
    return {
      title: `Deadline in 7 days: ${input.company}`,
      message: `${base} is due in 7 days (${deadlineText}).`,
    };
  }

  if (input.reminderType === "DEADLINE_D3") {
    return {
      title: `Deadline in 3 days: ${input.company}`,
      message: `${base} is due in 3 days (${deadlineText}).`,
    };
  }

  if (input.reminderType === "DEADLINE_D1") {
    return {
      title: `Deadline tomorrow: ${input.company}`,
      message: `${base} is due tomorrow (${deadlineText}).`,
    };
  }

  if (input.reminderType === "DEADLINE_TODAY") {
    return {
      title: `Deadline today: ${input.company}`,
      message: `${base} is due today (${deadlineText}).`,
    };
  }

  return {
    title: `Deadline passed: ${input.company}`,
    message: `${base} deadline passed on ${deadlineText}.`,
  };
}

function shouldSendScheduledEmail(
  reminderType: DeadlineReminderType,
  emailNotificationsEnabled: boolean
) {
  if (!emailNotificationsEnabled) return false;
  return (
    reminderType === "DEADLINE_D1" ||
    reminderType === "DEADLINE_TODAY" ||
    reminderType === "DEADLINE_OVERDUE_D1"
  );
}

function getApplicationsUrl() {
  const baseUrl =
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
    "http://localhost:3000";

  return `${baseUrl.replace(/\/$/, "")}/applications`;
}

async function processTrackedApplicationReminder(
  application: TrackedApplicationWithUser,
  now: Date,
  sendEmailImmediately: boolean
): Promise<"created" | "skipped"> {
  if (!application.deadline) return "skipped";

  const dayDiff = daysUntil(application.deadline, startOfUtcDay(now));
  const reminderType = mapReminderType(dayDiff);
  if (!reminderType) return "skipped";

  const deadlineDate = startOfUtcDay(application.deadline);
  const { count } = await prisma.reminderLog.createMany({
    data: [
      {
        userId: application.userId,
        trackedApplicationId: application.id,
        reminderType,
        deadlineDate,
      },
    ],
    skipDuplicates: true,
  });

  if (count === 0) return "skipped";

  const copy = buildReminderCopy({
    reminderType,
    company: application.company,
    roleTitle: application.roleTitle,
    deadline: application.deadline,
  });

  await prisma.notification.create({
    data: {
      userId: application.userId,
      trackedApplicationId: application.id,
      type: "DEADLINE_REMINDER",
      title: copy.title,
      message: copy.message,
    },
  });

  const applicationsUrl = getApplicationsUrl();
  const shouldEmail = sendEmailImmediately
    ? application.user.emailNotificationsEnabled
    : shouldSendScheduledEmail(
        reminderType,
        application.user.emailNotificationsEnabled
      );

  if (shouldEmail) {
    await sendEmail({
      to: application.user.email,
      subject: copy.title,
      text: `${copy.message}\n\nOpen applications: ${applicationsUrl}`,
      html: `
        <p>Hello${application.user.name ? ` ${application.user.name}` : ""},</p>
        <p>${copy.message}</p>
        <p><a href="${applicationsUrl}">Open applications</a></p>
      `,
    });
  }

  return "created";
}

export async function runDeadlineReminders(now = new Date()): Promise<ReminderRunResult> {
  const applications = await prisma.trackedApplication.findMany({
    where: {
      status: {
        in: TRACKED_ACTIVE_STATUSES satisfies TrackedApplicationStatus[],
      },
      deadline: { not: null },
    },
    select: {
      id: true,
      company: true,
      roleTitle: true,
      deadline: true,
      userId: true,
      user: {
        select: {
          email: true,
          emailNotificationsEnabled: true,
          name: true,
        },
      },
    },
  });

  let remindersCreated = 0;
  let remindersSkipped = 0;

  for (const application of applications) {
    const result = await processTrackedApplicationReminder(application, now, false);
    if (result === "created") {
      remindersCreated += 1;
    } else {
      remindersSkipped += 1;
    }
  }

  return {
    scannedApplications: applications.length,
    remindersCreated,
    remindersSkipped,
  };
}

export async function checkCustomReminders(now = new Date()) {
  const pending = await prisma.trackedApplicationEvent.findMany({
    where: {
      type: "REMINDER",
      reminderAt: { lte: now },
      reminderNotifiedAt: null,
    },
    select: {
      id: true,
      note: true,
      reminderAt: true,
      trackedApplication: {
        select: {
          id: true,
          company: true,
          roleTitle: true,
          userId: true,
          user: {
            select: {
              email: true,
              emailNotificationsEnabled: true,
              name: true,
            },
          },
        },
      },
    },
  });

  for (const event of pending) {
    const label = `${event.trackedApplication.company} — ${event.trackedApplication.roleTitle}`;
    const title = `Reminder: ${label}`;
    const message = event.note ? event.note : `Custom reminder for ${label}.`;

    await prisma.notification.create({
      data: {
        userId: event.trackedApplication.userId,
        trackedApplicationId: event.trackedApplication.id,
        type: "SYSTEM",
        title,
        message,
      },
    });

    await prisma.trackedApplicationEvent.update({
      where: { id: event.id },
      data: { reminderNotifiedAt: now },
    });

    if (event.trackedApplication.user.emailNotificationsEnabled) {
      await sendEmail({
        to: event.trackedApplication.user.email,
        subject: title,
        text: `${message}\n\nOpen applications: ${getApplicationsUrl()}`,
        html: `
          <p>Hello${event.trackedApplication.user.name ? ` ${event.trackedApplication.user.name}` : ""},</p>
          <p>${message}</p>
          <p><a href="${getApplicationsUrl()}">Open applications</a></p>
        `,
      });
    }
  }
}

export async function checkSingleTrackedApplicationReminder(applicationId: string) {
  const application = await prisma.trackedApplication.findFirst({
    where: {
      id: applicationId,
      deadline: { not: null },
      status: {
        in: TRACKED_ACTIVE_STATUSES,
      },
    },
    select: {
      id: true,
      company: true,
      roleTitle: true,
      deadline: true,
      userId: true,
      user: {
        select: {
          email: true,
          emailNotificationsEnabled: true,
          name: true,
        },
      },
    },
  });

  if (!application) return;
  await processTrackedApplicationReminder(application, new Date(), true);
}
