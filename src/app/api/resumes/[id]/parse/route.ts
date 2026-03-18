import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseResumePdf } from "@/lib/resume/parser";
import fs from "fs/promises";
import path from "path";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const resume = await prisma.resume.findUnique({
      where: { id },
    });

    if (!resume || resume.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const filePath = path.join(process.cwd(), "public", resume.fileUrl);
    const fileBuffer = await fs.readFile(filePath);

    const parsed = await parseResumePdf(fileBuffer);

    const updated = await prisma.resume.update({
      where: { id },
      data: {
        parsedText: parsed.text,
        skills: parsed.skills,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Failed to parse resume:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
