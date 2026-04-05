"use server";

import { getComparableDocumentText } from "@/lib/queries/tracker";

export async function getDocumentText(documentId: string) {
  return getComparableDocumentText(documentId);
}
